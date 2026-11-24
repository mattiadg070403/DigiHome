import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp } from '../src/ops.js';
import '../src/guests.js';
import { countryAlias, formInfo, formPlaces, submitForm } from '../src/guest-form.js';
import { handle } from '../src/public-guests.js';
import { readState } from '../src/state.js';
import { addDays, todayRome } from '../public/shared/dates.js';

const T = todayRome();
const op = () => crypto.randomUUID();
const ITALY = '100000100';

async function setup({ checkIn = addDays(T, 5), guests = 2 } = {}) {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', name: 'Mattia', role: 'admin' });
  const places = [[ITALY, 'ITALIA', null, 'S'], ['100000216', 'GERMANIA', null, 'S'], ['403075031', 'GALLIPOLI', 'LE', 'C'], ['403075035', 'LECCE', 'LE', 'C']];
  for (const p of places) await db.prepare('INSERT INTO places (code, name, province, kind, active) VALUES (?, ?, ?, ?, 1)').bind(...p).run();
  await db.prepare("INSERT INTO doc_types (code, name) VALUES ('IDENT', 'CARTA DI IDENTITA'), ('PASOR', 'PASSAPORTO ORDINARIO')").run();
  const b = (await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: {
    house_id: 'faro-blu', channel: 'airbnb', guest_name: 'Famiglia Bauer', phone: '+49 000 000', guests,
    check_in: checkIn, check_out: addDays(checkIn, 7), total_cents: 100000, deposit_cents: 0, security_cents: 0,
  } } })).record;
  const linked = (await runOp(db, admin, { opId: op(), type: 'booking.guest_link', payload: { id: b.id, action: 'create' } })).record;
  return { db, admin, b: linked, token: linked.guest_form_token };
}

const lead = { last_name: 'Bauer', first_name: 'Jürgen', sex: 'M', birth_date: '1979-03-14', birth_place: '100000216', citizenship: '100000216',
  residence: '100000216', doc_type: 'PASOR', doc_number: 'C01X00T47', doc_place: '100000216' };
const second = { last_name: 'Bauer', first_name: 'Anna', sex: 'F', birth_date: '1981-07-02', birth_place: '403075035', citizenship: ITALY, residence: '100000216' };

test('link: codice casuale di 48 caratteri, si rinnova e si disattiva', async () => {
  const { db, admin, b, token } = await setup();
  assert.match(token, /^[1-9A-HJ-NP-Za-km-z]{12}$/);
  const again = (await runOp(db, admin, { opId: op(), type: 'booking.guest_link', payload: { id: b.id, action: 'create' } })).record;
  assert.equal(again.guest_form_token, token); // già creato: resta lo stesso
  const renewed = (await runOp(db, admin, { opId: op(), type: 'booking.guest_link', payload: { id: b.id, action: 'create', renew: true } })).record;
  assert.notEqual(renewed.guest_form_token, token);
  await assert.rejects(formInfo(db, token), /Link non valido/);
  const off = (await runOp(db, admin, { opId: op(), type: 'booking.guest_link', payload: { id: b.id, action: 'revoke' } })).record;
  assert.equal(off.guest_form_token, null);
});

test('pagina: solo casa, date e numero di ospiti (niente nomi, telefono o dati già salvati)', async () => {
  const { db, token } = await setup();
  const info = await formInfo(db, token);
  assert.equal(info.open, true);
  assert.equal(info.house, 'Faro Blu');
  assert.equal(info.guests, 2);
  assert.equal(info.docTypes.length, 2);
  const text = JSON.stringify(info);
  assert.ok(!text.includes('Bauer') && !text.includes('+49'));
  assert.deepEqual((await formPlaces(db, token, 'germany', 'S')).map((p) => p.name), ['GERMANIA']);
  assert.equal(countryAlias('united k'), 'REGNO UNITO');
  assert.deepEqual((await formPlaces(db, token, 'lec', 'C')).map((p) => p.name), ['LECCE']);
});

const P1 = 'telefono-di-chi-ha-prenotato';
const P2 = 'telefono-del-secondo-ospite';
const P3 = 'telefono-del-terzo-ospite_';
const asLead = (guests, extra = {}) => ({ part: P1, leader: true, group: 'famiglia', guests, ...extra });
const names = async (db, id) => (await db.prepare('SELECT first_name FROM guests WHERE booking_id = ? AND deleted = 0 ORDER BY position').bind(id).all()).results.map((x) => x.first_name);

test('invio: dati salvati nella scheda, controlli come nel gestionale, nessun dato personale nel registro', async () => {
  const { db, admin, b, token } = await setup();
  await assert.rejects(submitForm(db, token, { leader: true, guests: [lead, second] }), /Richiesta non valida/); // manca il codice del telefono
  await assert.rejects(submitForm(db, token, asLead([{ ...lead, doc_number: null }, second])), /Ospite 1: manca numero del documento/);
  await assert.rejects(submitForm(db, token, asLead([lead, { ...second, first_name: 'Анна' }])), /Ospite 2: .*lettere latine/);
  await assert.rejects(submitForm(db, token, asLead([lead, { ...second, birth_place: '999999999' }])), /Ospite 2: luogo non valido/);
  await assert.rejects(submitForm(db, token, asLead([{ ...lead, citizenship: '403075031' }, second])), /cittadinanza deve essere uno stato/);
  await assert.rejects(submitForm(db, token, asLead([])), /Numero di ospiti/);
  const r = await submitForm(db, token, asLead([lead, { ...second, doc_number: 'NON-SALVARE' }]));
  assert.equal(r.count, 2);
  const rows = (await db.prepare('SELECT * FROM guests WHERE booking_id = ? ORDER BY position').bind(b.id).all()).results;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'ospite');
  assert.equal(rows[0].doc_number, 'C01X00T47');
  assert.equal(rows[1].doc_number, null); // il documento serve solo a chi ha prenotato
  const bk = await db.prepare('SELECT guests_entered, guests_done, guest_form_at, guest_form_submits, guest_group FROM bookings WHERE id = ?').bind(b.id).first();
  assert.deepEqual([bk.guests_entered, bk.guests_done, bk.guest_form_submits, bk.guest_group], [2, 2, 1, 'famiglia']);
  assert.ok(bk.guest_form_at);
  const log = JSON.stringify((await db.prepare('SELECT * FROM audit_log').all()).results);
  assert.ok(!log.includes('Jürgen') && !log.includes('C01X00T47'));
  assert.ok(!JSON.stringify(await readState(db, admin)).includes('C01X00T47'));
  // Un nuovo invio dallo stesso telefono sostituisce il precedente (e i vecchi dati spariscono davvero).
  await submitForm(db, token, asLead([{ ...lead, first_name: 'Hans' }]));
  const all = (await db.prepare('SELECT first_name FROM guests WHERE booking_id = ?').bind(b.id).all()).results;
  assert.deepEqual(all.map((x) => x.first_name), ['Hans']);
});

test('più telefoni: ognuno inserisce i suoi, i dati si sommano e chi ha prenotato resta primo', async () => {
  const { db, b, token } = await setup({ guests: 3 });
  // Prima arriva un altro ospite (senza documento), poi chi ha prenotato.
  await submitForm(db, token, { part: P2, leader: false, guests: [second] });
  let info = await formInfo(db, token, T, P2);
  assert.deepEqual([info.entered, info.mine, info.leaderTaken, info.iAmLeader], [1, 1, false, false]);
  await submitForm(db, token, asLead([lead]));
  assert.deepEqual(await names(db, b.id), ['Jürgen', 'Anna']); // chi ha prenotato (con documento) diventa il capo
  // Il terzo inserisce sé e un accompagnatore; non può dichiararsi "chi ha prenotato".
  info = await formInfo(db, token, T, P3);
  assert.deepEqual([info.entered, info.mine, info.leaderTaken], [2, 0, true]);
  await assert.rejects(submitForm(db, token, { part: P3, leader: true, guests: [lead] }), (e) => e.code === 'leader_taken');
  await submitForm(db, token, { part: P3, leader: false, guests: [{ ...second, first_name: 'Karl', sex: 'M' }, { ...second, first_name: 'Lena' }] });
  assert.deepEqual(await names(db, b.id), ['Jürgen', 'Anna', 'Karl', 'Lena']);
  // Il secondo corregge i suoi dati: cambiano solo i suoi, l'ordine resta.
  await submitForm(db, token, { part: P2, leader: false, guests: [{ ...second, first_name: 'Annette' }] });
  assert.deepEqual(await names(db, b.id), ['Jürgen', 'Annette', 'Karl', 'Lena']);
  const pos = (await db.prepare('SELECT position FROM guests WHERE booking_id = ? AND deleted = 0 ORDER BY position').bind(b.id).all()).results.map((x) => x.position);
  assert.deepEqual(pos, [0, 1, 2, 3]);
  const bk = await db.prepare('SELECT guests_entered, guest_form_submits, guest_group FROM bookings WHERE id = ?').bind(b.id).first();
  assert.deepEqual([bk.guests_entered, bk.guest_form_submits, bk.guest_group], [4, 4, 'famiglia']); // il tipo di gruppo lo sceglie solo chi ha prenotato
  // Chi ha prenotato può ricompilare dal suo telefono (resta il capo).
  assert.equal((await formInfo(db, token, T, P1)).iAmLeader, true);
  await submitForm(db, token, asLead([{ ...lead, first_name: 'Hans' }], { group: 'gruppo' }));
  assert.deepEqual(await names(db, b.id), ['Hans', 'Annette', 'Karl', 'Lena']);
  // Limite: in tutto al massimo gli ospiti prenotati + 4.
  const many = Array.from({ length: 4 }, (_, i) => ({ ...second, first_name: `Extra${'abcd'[i]}` }));
  await assert.rejects(submitForm(db, token, { part: 'telefono-di-troppo-1234', leader: false, guests: many }), /già stati inseriti 4 ospiti su 3/);
});

test('il modulo si chiude: schedine inviate, link scaduto, prenotazione cancellata, troppi invii', async () => {
  const s1 = await setup();
  await s1.db.prepare('UPDATE bookings SET alloggiati_at = ? WHERE id = ?').bind(new Date().toISOString(), s1.b.id).run();
  const closed = await formInfo(s1.db, s1.token);
  assert.equal(closed.reason, 'done');
  // Link chiuso: niente date, persone o locatore (chi lo ritrova in una chat non scopre il soggiorno).
  assert.deepEqual(Object.keys(closed).sort(), ['color', 'house', 'open', 'reason']);
  await assert.rejects(submitForm(s1.db, s1.token, asLead([lead])), /non è più disponibile/);
  // Un mese dopo la partenza il codice si cancella: il link non esiste più.
  const { purgeGuests } = await import('../src/guests.js');
  await purgeGuests(s1.db, addDays(s1.b.check_out, 31));
  await assert.rejects(formInfo(s1.db, s1.token), /Link non valido/);
  const s2 = await setup({ checkIn: T });
  assert.equal((await formInfo(s2.db, s2.token, addDays(T, 1))).open, true); // anche il giorno dopo l'arrivo
  assert.equal((await formInfo(s2.db, s2.token, addDays(T, 2))).reason, 'expired');
  const s3 = await setup();
  await s3.db.prepare("UPDATE bookings SET stage = 'cancellata' WHERE id = ?").bind(s3.b.id).run();
  assert.equal((await formInfo(s3.db, s3.token)).reason, 'cancelled');
  const s4 = await setup();
  await s4.db.prepare('UPDATE bookings SET guest_form_submits = 40 WHERE id = ?').bind(s4.b.id).run();
  await assert.rejects(submitForm(s4.db, s4.token, asLead([lead])), /non è più disponibile/);
});

test('Worker pubblico: solo le sue pagine, intestazioni di sicurezza, POST solo dalla stessa origine', async () => {
  const { db, token } = await setup();
  const ASSETS = { fetch: async (req) => new Response(new URL(req.url).pathname === '/index.html' ? '<!doctype html><title>x</title>' : 'js', { headers: { 'Content-Type': 'text/html' } }) };
  const env = { DB: db, ASSETS };
  const base = 'https://digihome-ospiti.example';
  const page = await handle(new Request(`${base}/${token}`), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  assert.equal((await handle(new Request(`${base}/`), env)).status, 404);
  assert.equal((await handle(new Request(`${base}/api/state`), env)).status, 404);
  assert.equal((await handle(new Request(`${base}/api/form/${'1'.repeat(12)}`), env)).status, 404);
  assert.equal((await handle(new Request(`${base}/api/form/${'1'.repeat(12)}/places?q=ger`), env)).status, 404);
  assert.equal((await handle(new Request(`${base}/${'0'.repeat(12)}`), env)).status, 404); // 0 non è nell'alfabeto
  const info = await (await handle(new Request(`${base}/api/form/${token}?part=${P1}`), env)).json();
  assert.equal(info.form.open, true);
  assert.equal(info.form.mine, 0);
  const post = (headers, body) => handle(new Request(`${base}/api/form/${token}`, { method: 'POST', headers, body }), env);
  assert.equal((await post({ 'Content-Type': 'application/json', Origin: 'https://evil.example' }, '{}')).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain' }, '{}')).status, 415);
  assert.equal((await post({ 'Content-Type': 'application/json' }, 'x'.repeat(70000))).status, 413);
  // Anche senza Content-Length (corpo a pezzi): si ferma appena supera il limite.
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 100; i++) c.enqueue(new TextEncoder().encode('x'.repeat(10000))); c.close(); } });
  assert.equal((await handle(new Request(`${base}/api/form/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' }), env)).status, 413);
  const ok = await post({ 'Content-Type': 'application/json', Origin: base }, JSON.stringify(asLead([lead, second])));
  assert.equal(ok.status, 200);
  assert.equal((await handle(new Request(`${base}/robots.txt`), env)).status, 200);
});

test('codici dei link: 12 caratteri senza simboli che si confondono, tutti diversi', async () => {
  const { newFormToken } = await import('../src/guest-form.js');
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const t = newFormToken();
    assert.match(t, /^[1-9A-HJ-NP-Za-km-z]{12}$/);
    seen.add(t);
  }
  assert.equal(seen.size, 2000);
});
