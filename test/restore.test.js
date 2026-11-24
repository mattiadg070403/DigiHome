// Prova concreta del ripristino: copia dei dati → istruzioni SQL → database nuovo → stessi dati, tabella per tabella.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp } from '../src/ops.js';
import '../src/guests.js';
import { loadDemo } from '../src/demo.js';
import { readExport, readState } from '../src/state.js';
import { buildRestoreSql } from '../src/restore.js';
import { addDays, todayRome } from '../public/shared/dates.js';

const T = todayRome();
const TABLES = ['houses', 'users', 'bookings', 'booking_notes', 'tasks', 'booking_extras', 'expenses', 'deadlines', 'contracts',
  'remittances', 'price_lists', 'pay_receipts', 'guests', 'market_comps', 'market_prices', 'audit_log'];
const dump = (db, t) => db.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...r }));

test('ripristino: la copia dei dati ricostruisce il gestionale in un database nuovo, identico', async () => {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', name: 'Mattia', role: 'admin' });
  await addUser(db, { email: 'collab@example.invalid', name: 'Rosa', role: 'collaboratore' });
  await loadDemo(db, admin);
  // Ospite con il documento, testi con apostrofi e accenti, un listino, una ricevuta della Questura grande (PDF a pezzi).
  const b = (await runOp(db, admin, { opId: crypto.randomUUID(), type: 'booking.create', payload: { booking: {
    house_id: 'faro-blu', channel: 'diretto', guest_name: "Famiglia D'Angelo – àèìòù", guests: 1,
    check_in: addDays(T, 40), check_out: addDays(T, 47), total_cents: 123456, deposit_cents: 0, security_cents: 0, notes: "Arriva con l'auto; \"tardi\"" } } })).record;
  db.sqlite.prepare(`INSERT INTO guests (id, booking_id, position, code, last_name, first_name, sex, birth_date, birth_place, citizenship, residence, doc_type, doc_number, doc_place, complete, source, created_at, created_by)
    VALUES (?, ?, 0, 987654, 'D''ANGELO', 'Lucia', 'F', '1980-02-03', '403075031', '100000100', '403075031', 'IDENT', 'CA1234567', '403075031', 1, 'gestore', ?, 'admin@example.invalid')`)
    .run(crypto.randomUUID(), b.id, new Date().toISOString());
  await runOp(db, admin, { opId: crypto.randomUUID(), type: 'price.set', payload: { house_id: 'faro-blu', year: 2027, weeks: { '2027-07-03': 180000 } } });
  const pdf = new Uint8Array(150_000).map((_, i) => (i * 37 + 11) % 256);
  db.sqlite.prepare(`INSERT INTO alloggiati_receipts (id, house_id, date, pdf, size, sha256, fetched_at, purge_after) VALUES ('r1', 'faro-blu', ?, ?, ?, 'x', ?, ?)`)
    .run(T, pdf, pdf.length, new Date().toISOString(), addDays(T, 1800));
  db.sqlite.prepare(`INSERT INTO market_comps (id, house_id, listing_id, url, title, capacity, selected, source, found_at)
    VALUES ('faro-blu:123', 'faro-blu', '123', 'https://www.airbnb.it/rooms/123', 'Casa ''Vista''', 8, 1, 'manuale', ?)`).run(new Date().toISOString());

  // Copia (come la scarica l'app) → JSON → SQL
  const copy = JSON.parse(JSON.stringify({ ok: true, app: 'DigiHome', version: 'test', env: 'prova', exported_at: new Date().toISOString(), ...(await readExport(db)) }));
  const { sql, counts } = buildRestoreSql(copy);
  assert.ok(counts.bookings > 5 && counts.guests >= 1 && counts.alloggiati_receipts === 1);
  for (const line of sql.split('\n')) assert.ok(line.length < 100_000, 'ogni istruzione entra nei limiti di D1');
  assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b/);

  // Database nuovo: migrazioni, poi il ripristino.
  const fresh = freshDb();
  fresh.sqlite.exec(sql);
  for (const t of TABLES) assert.deepEqual(dump(fresh, t), dump(db, t), `tabella ${t}`);
  const cal = (d) => d.sqlite.prepare('SELECT id, house_id, channel, last_sync_at, last_ok_at, last_error, last_count, version FROM calendars ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(cal(fresh), cal(db));
  const hexOf = (d) => d.sqlite.prepare("SELECT hex(pdf) AS h, size FROM alloggiati_receipts WHERE id = 'r1'").get();
  assert.deepEqual({ ...hexOf(fresh) }, { ...hexOf(db) });
  assert.equal(fresh.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = '_ripristino_pezzi'").get().n, 0);
  // Il gestionale ripristinato funziona: lo stato si legge e si può continuare a lavorare.
  const rev = (d) => d.sqlite.prepare("SELECT value FROM meta WHERE key = 'rev'").get().value;
  assert.ok(rev(fresh) >= rev(db));
  const st = await readState(fresh, { ...admin, role: 'admin' });
  assert.equal(st.bookings.length, (await readState(db, { ...admin, role: 'admin' })).bookings.length);
  await runOp(fresh, admin, { opId: crypto.randomUUID(), type: 'booking.update', payload: { id: b.id, version: b.version, changes: { guests: 1, notes: 'dopo il ripristino' } } });

  // Rifarlo due volte non crea doppioni; una copia non valida viene rifiutata.
  fresh.sqlite.exec(sql);
  assert.equal(fresh.sqlite.prepare('SELECT count(*) AS n FROM bookings').get().n, db.sqlite.prepare('SELECT count(*) AS n FROM bookings').get().n);
  assert.throws(() => buildRestoreSql({ app: 'Altro' }), /Non è una copia/);
  assert.throws(() => buildRestoreSql({ ...copy, bookings: [{ "id'); DROP TABLE x; --": 1 }] }), /Colonna non valida/);
});

test('copia dei dati: niente credenziali né link riservati dei calendari', async () => {
  const db = freshDb();
  db.sqlite.prepare("UPDATE calendars SET import_url = 'https://www.airbnb.it/calendar/ical/segreto.ics', export_token = 'tok-segreto-' || id").run();
  const ex = JSON.stringify(await readExport(db));
  assert.doesNotMatch(ex, /segreto/);
});
