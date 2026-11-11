import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp, OpError } from '../src/ops.js';
import { readState, readHistory } from '../src/state.js';
import { addDays, todayRome } from '../public/shared/dates.js';

const T = todayRome();
const op = () => crypto.randomUUID();

function booking(over = {}) {
  return {
    house_id: 'faro-blu', channel: 'diretto', guest_name: 'Ospite Prova', phone: '+39 000 000', guests: 4,
    check_in: addDays(T, 10), check_out: addDays(T, 17), total_cents: 100000, deposit_cents: 30000,
    deposit_paid: true, security_cents: 30000, ...over,
  };
}

async function setup() {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', role: 'admin' });
  const collab = await addUser(db, { email: 'collab@example.invalid', name: 'Collab', role: 'collaboratore' });
  return { db, admin, collab };
}

async function expectOpError(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof OpError, `atteso OpError, ottenuto ${e}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
}

async function rev(db) {
  return (await db.prepare("SELECT value FROM meta WHERE key = 'rev'").first()).value;
}

test('crea una prenotazione e la scrive nel registro', async () => {
  const { db, admin } = await setup();
  const r = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  assert.equal(r.ok, true);
  assert.equal(r.record.guest_name, 'Ospite Prova');
  assert.equal(r.record.version, 1);
  assert.equal(r.record.security_status, 'da_incassare');
  assert.equal(await rev(db), 1);
  assert.equal(r.record.rev, 1);
  const h = await readHistory(db, r.record.id);
  assert.equal(h.length, 1);
  assert.equal(h[0].action, 'create');
});

test('rifiuta date sovrapposte nella stessa casa, accetta in un’altra casa e giorno di cambio', async () => {
  const { db, admin } = await setup();
  await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ check_in: addDays(T, 12), check_out: addDays(T, 14) }) } }), 'overlap');
  // Stesse date, altra casa: va bene
  await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking({ house_id: 'isola-bella', guests: 2 }) } });
  // Entra il giorno in cui l'altro esce: va bene
  await runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ check_in: addDays(T, 17), check_out: addDays(T, 20) }) } });
  assert.equal(await rev(db), 3);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM bookings').first();
  assert.equal(n.n, 3);
  const logs = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first();
  assert.equal(logs.n, 3, 'un tentativo rifiutato non lascia tracce nel registro');
});

test('stesso codice operazione inviato due volte: eseguito una sola volta', async () => {
  const { db, admin } = await setup();
  const id = op();
  const a = await runOp(db, admin, { opId: id, type: 'booking.create', payload: { booking: booking() } });
  const b = await runOp(db, admin, { opId: id, type: 'booking.create', payload: { booking: booking() } });
  assert.equal(b.replay, true);
  assert.equal(b.id, a.record.id);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM bookings').first();
  assert.equal(n.n, 1);
});

test('un codice operazione di un altro utente non viene riusato', async () => {
  const { db, admin, collab } = await setup();
  const id = op();
  await runOp(db, admin, { opId: id, type: 'booking.create', payload: { booking: booking() } });
  await expectOpError(runOp(db, collab, { opId: id, type: 'booking.create', payload: { booking: booking() } }), 'validation');
});

test('modifica con versione vecchia: conflitto, nessuna sovrascrittura', async () => {
  const { db, admin, collab } = await setup();
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  const u1 = await runOp(db, admin, { opId: op(), type: 'booking.update',
    payload: { id: record.id, version: 1, changes: { guests: 5 } } });
  assert.equal(u1.record.version, 2);
  await expectOpError(runOp(db, collab, { opId: op(), type: 'booking.update',
    payload: { id: record.id, version: 1, changes: { guests: 3 } } }), 'conflict');
  const cur = await db.prepare('SELECT guests, version FROM bookings WHERE id = ?').bind(record.id).first();
  assert.deepEqual(cur, { guests: 5, version: 2 });
});

test('modifica delle date verso date occupate: rifiutata', async () => {
  const { db, admin } = await setup();
  await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ check_in: addDays(T, 20), check_out: addDays(T, 25) }) } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.update',
    payload: { id: record.id, version: 1, changes: { check_in: addDays(T, 15) } } }), 'overlap');
  // Spostare in avanti dentro le proprie date va bene (non si scontra con sé stessa)
  const r = await runOp(db, admin, { opId: op(), type: 'booking.update',
    payload: { id: record.id, version: 1, changes: { check_in: addDays(T, 21) } } });
  assert.equal(r.record.check_in, addDays(T, 21));
});

test('validazione: campi sbagliati, massimo ospiti, acconto oltre il totale, campo non modificabile', async () => {
  const { db, admin } = await setup();
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ guests: 7, house_id: 'isola-bella' }) } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ check_out: addDays(T, 10) }) } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ deposit_cents: 200000 }) } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ guest_name: '   ' }) } }), 'validation');
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.update',
    payload: { id: record.id, version: 1, changes: { stage: 'chiusa' } } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.update',
    payload: { id: record.id, version: 1, changes: { deposit_cents: 150000 } } }), 'validation');
});

test('check-in guidato: non si conclude senza i passaggi obbligatori, poi sì', async () => {
  const { db, admin } = await setup();
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ check_in: T, check_out: addDays(T, 5) }) } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.checkin',
    payload: { id: record.id, version: 1 } }), 'validation');
  for (const step of ['ospiti', 'documenti', 'pagamenti', 'contratto']) {
    await runOp(db, admin, { opId: op(), type: 'booking.step', payload: { id: record.id, flow: 'checkin', step, done: true } });
  }
  // Alloggiati e DMS Puglia sono obbligatori: senza, il check-in non si conclude.
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.checkin', payload: { id: record.id, version: 1 } }), 'validation');
  await runOp(db, admin, { opId: op(), type: 'booking.step', payload: { id: record.id, flow: 'checkin', step: 'alloggiati', done: true } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.checkin', payload: { id: record.id, version: 1 } }), 'validation');
  await runOp(db, admin, { opId: op(), type: 'booking.step', payload: { id: record.id, flow: 'checkin', step: 'dms', done: true } });
  const cur = await db.prepare('SELECT version, checkin_steps FROM bookings WHERE id = ?').bind(record.id).first();
  assert.equal(cur.version, 1, 'spuntare un passaggio non cambia la versione');
  assert.deepEqual(JSON.parse(cur.checkin_steps), { ospiti: 1, documenti: 1, pagamenti: 1, contratto: 1, alloggiati: 1, dms: 1 });
  const r = await runOp(db, admin, { opId: op(), type: 'booking.checkin', payload: { id: record.id, version: 1 } });
  assert.equal(r.record.stage, 'in_casa');
  assert.equal(r.record.security_status, 'incassata');
  // Annulla: torna a confermata con cauzione da incassare
  const back = await runOp(db, admin, { opId: op(), type: 'booking.step_back', payload: { id: record.id, version: 2 } });
  assert.equal(back.record.stage, 'confermata');
  assert.equal(back.record.security_status, 'da_incassare');
});

test('delega minorenni: diventa un passaggio obbligatorio del check-in', async () => {
  const { db, admin } = await setup();
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ check_in: T, check_out: addDays(T, 5), minors_delegation: 'da_chiedere' }) } });
  for (const step of ['ospiti', 'documenti', 'pagamenti', 'contratto', 'alloggiati', 'dms']) {
    await runOp(db, admin, { opId: op(), type: 'booking.step', payload: { id: record.id, flow: 'checkin', step, done: true } });
  }
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.checkin', payload: { id: record.id, version: 1 } }), 'validation');
  await runOp(db, admin, { opId: op(), type: 'booking.step', payload: { id: record.id, flow: 'checkin', step: 'minori', done: true } });
  const r = await runOp(db, admin, { opId: op(), type: 'booking.checkin', payload: { id: record.id, version: 1 } });
  assert.equal(r.record.stage, 'in_casa');
});

test('check-out: cauzione obbligatoria, trattenuta con importo e motivo, poi chiusura', async () => {
  const { db, admin } = await setup();
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create',
    payload: { booking: booking({ check_in: addDays(T, -3), check_out: T }) } });
  for (const step of ['ospiti', 'documenti', 'pagamenti', 'contratto', 'alloggiati', 'dms']) {
    await runOp(db, admin, { opId: op(), type: 'booking.step', payload: { id: record.id, flow: 'checkin', step, done: true } });
  }
  await runOp(db, admin, { opId: op(), type: 'booking.checkin', payload: { id: record.id, version: 1 } });
  for (const step of ['controllo', 'chiavi']) {
    await runOp(db, admin, { opId: op(), type: 'booking.step', payload: { id: record.id, flow: 'checkout', step, done: true } });
  }
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.checkout', payload: { id: record.id, version: 2 } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.checkout',
    payload: { id: record.id, version: 2, security: { status: 'trattenuta', withheld_cents: 5000 } } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.checkout',
    payload: { id: record.id, version: 2, security: { status: 'trattenuta', withheld_cents: 99999, note: 'x' } } }), 'validation');
  const r = await runOp(db, admin, { opId: op(), type: 'booking.checkout',
    payload: { id: record.id, version: 2, security: { status: 'trattenuta', withheld_cents: 5000, note: 'Bicchieri rotti' } } });
  assert.equal(r.record.stage, 'partita');
  assert.equal(r.record.security_status, 'trattenuta');
  assert.equal(r.record.security_withheld_cents, 5000);
  const c = await runOp(db, admin, { opId: op(), type: 'booking.close', payload: { id: record.id, version: 3, review_ok: true } });
  assert.equal(c.record.stage, 'chiusa');
  assert.equal(c.record.review_ok, 1);
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.update',
    payload: { id: record.id, version: 4, changes: { guests: 2 } } }), 'state');
});

test('cancellare libera le date; ripristinare controlla che siano ancora libere', async () => {
  const { db, admin } = await setup();
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  await runOp(db, admin, { opId: op(), type: 'booking.cancel', payload: { id: record.id, version: 1 } });
  const other = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking({ guest_name: 'Altro' }) } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.restore', payload: { id: record.id, version: 2 } }), 'overlap');
  await runOp(db, admin, { opId: op(), type: 'booking.cancel', payload: { id: other.record.id, version: 1 } });
  const r = await runOp(db, admin, { opId: op(), type: 'booking.restore', payload: { id: record.id, version: 2 } });
  assert.equal(r.record.stage, 'confermata');
});

test('note e cose da fare con annulla', async () => {
  const { db, admin, collab } = await setup();
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  const n = await runOp(db, collab, { opId: op(), type: 'note.add', payload: { bookingId: record.id, text: 'Ombrellone in più' } });
  await expectOpError(runOp(db, collab, { opId: op(), type: 'note.add', payload: { bookingId: record.id, text: '  ' } }), 'validation');
  await runOp(db, collab, { opId: op(), type: 'note.delete', payload: { id: n.record.id } });
  let st = await readState(db, collab);
  assert.equal(st.notes.length, 0);
  await runOp(db, collab, { opId: op(), type: 'note.restore', payload: { id: n.record.id } });
  st = await readState(db, collab);
  assert.equal(st.notes.length, 1);

  const t = await runOp(db, collab, { opId: op(), type: 'task.add', payload: { task: { title: 'Pulizie', house_id: 'faro-blu', due_date: T } } });
  const done = await runOp(db, collab, { opId: op(), type: 'task.toggle', payload: { id: t.record.id, done: true } });
  assert.equal(done.record.done, 1);
  const again = await runOp(db, collab, { opId: op(), type: 'task.toggle', payload: { id: t.record.id, done: true } });
  assert.equal(again.unchanged, true, 'spuntare due volte non crea doppioni nel registro');
  await runOp(db, collab, { opId: op(), type: 'task.toggle', payload: { id: t.record.id, done: false } });
  const logs = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'task'").first();
  assert.equal(logs.n, 3);
});

test('un’operazione senza effetti subito dopo una riuscita non lascia tracce', async () => {
  const { db, admin } = await setup();
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  const before = await rev(db);
  // Stessa casa, prenotazione appena modificata (rev uguale al contatore), modifica identica
  const r = await runOp(db, admin, { opId: op(), type: 'booking.update',
    payload: { id: record.id, version: 1, changes: { guests: 4 } } });
  assert.equal(r.unchanged, true);
  const n = await runOp(db, admin, { opId: op(), type: 'note.add', payload: { bookingId: record.id, text: 'a' } });
  await runOp(db, admin, { opId: op(), type: 'note.delete', payload: { id: n.record.id } });
  const again = await runOp(db, admin, { opId: op(), type: 'note.delete', payload: { id: n.record.id } });
  assert.equal(again.unchanged, true);
  assert.equal(await rev(db), before + 2);
  const logs = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first();
  assert.equal(logs.n, 3);
  const ops = await db.prepare('SELECT COUNT(*) AS n FROM ops').first();
  assert.equal(ops.n, 3);
});

test('solo l’amministratore cambia utenti e case; resta sempre un amministratore', async () => {
  const { db, admin, collab } = await setup();
  await expectOpError(runOp(db, collab, { opId: op(), type: 'user.add',
    payload: { email: 'x@example.invalid', name: 'X', role: 'admin' } }), 'forbidden');
  await expectOpError(runOp(db, collab, { opId: op(), type: 'house.update',
    payload: { id: 'faro-blu', version: 1, changes: { max_guests: 12 } } }), 'forbidden');
  const u = await runOp(db, admin, { opId: op(), type: 'user.add', payload: { email: 'Nuovo@Example.invalid', name: 'Nuovo', role: 'collaboratore' } });
  assert.equal(u.record.email, 'nuovo@example.invalid');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'user.add',
    payload: { email: 'nuovo@example.invalid', name: 'Doppio', role: 'collaboratore' } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'user.update',
    payload: { id: admin.id, version: 1, changes: { active: false } } }), 'validation');
  const h = await runOp(db, admin, { opId: op(), type: 'house.update', payload: { id: 'faro-blu', version: 1, changes: { max_guests: 12 } } });
  assert.equal(h.record.max_guests, 12);
  await expectOpError(runOp(db, admin, { opId: op(), type: 'house.update',
    payload: { id: 'faro-blu', version: 1, changes: { max_guests: 9 } } }), 'conflict');
});

test('il collaboratore non vede le email degli altri utenti', async () => {
  const { db, collab, admin } = await setup();
  const st = await readState(db, collab);
  assert.ok(st.users.every((u) => !('email' in u)));
  const sa = await readState(db, admin);
  assert.ok(sa.users.every((u) => 'email' in u));
});

test('operazioni sconosciute o malformate vengono rifiutate', async () => {
  const { db, admin } = await setup();
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.drop' }), 'validation');
  await expectOpError(runOp(db, admin, { opId: 'corto', type: 'booking.create', payload: {} }), 'validation');
  await expectOpError(runOp(db, admin, null), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.update',
    payload: { id: "x'; DROP TABLE bookings;--", version: 1, changes: {} } }), 'validation');
});

test('il contatore cresce di uno per ogni modifica riuscita, mai per quelle rifiutate', async () => {
  const { db, admin } = await setup();
  const { record } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.update',
    payload: { id: record.id, version: 9, changes: { guests: 2 } } }), 'conflict');
  assert.equal(await rev(db), 1);
  await runOp(db, admin, { opId: op(), type: 'booking.update', payload: { id: record.id, version: 1, changes: { guests: 2 } } });
  assert.equal(await rev(db), 2);
  const st = await readState(db, admin);
  assert.equal(st.rev, 2);
  assert.equal(st.bookings[0].rev, 2);
});

test('extra della prenotazione (es. tassa di soggiorno): aggiunta, incasso, modifica, eliminazione e ripristino', async () => {
  const { db, admin } = await setup();
  const { record: b } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking({ channel: 'airbnb', total_cents: 50000 }) } });
  const add = await runOp(db, admin, { opId: op(), type: 'extra.add', payload: { bookingId: b.id, extra: { kind: 'tassa_soggiorno', amount_cents: 1200, paid: 0 } } });
  assert.equal(add.record.amount_cents, 1200);
  assert.equal(add.record.paid, 0);
  await expectOpError(runOp(db, admin, { opId: op(), type: 'extra.add', payload: { bookingId: b.id, extra: { kind: 'altro', amount_cents: 500 } } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'extra.add', payload: { bookingId: b.id, extra: { kind: 'altro', label: 'Garage', amount_cents: 0 } } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'extra.add', payload: { bookingId: b.id, extra: { kind: 'tassa_soggiorno', amount_cents: 500 } } }), 'state', 'una sola tassa per prenotazione');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'extra.add', payload: { bookingId: b.id, extra: { kind: 'boh', amount_cents: 100 } } }), 'validation');
  const paid = await runOp(db, admin, { opId: op(), type: 'extra.update', payload: { id: add.record.id, version: add.record.version, changes: { paid: 1 } } });
  assert.equal(paid.record.paid, 1);
  assert.ok(paid.record.paid_at);
  await expectOpError(runOp(db, admin, { opId: op(), type: 'extra.update', payload: { id: add.record.id, version: add.record.version, changes: { paid: 0 } } }), 'conflict');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'extra.update', payload: { id: add.record.id, version: paid.record.version, changes: { booking_id: 'x' } } }), 'validation');
  const del = await runOp(db, admin, { opId: op(), type: 'extra.delete', payload: { id: add.record.id } });
  assert.equal(del.record.deleted, 1);
  let st = await readState(db, admin);
  assert.equal(st.extras.length, 0);
  await runOp(db, admin, { opId: op(), type: 'extra.restore', payload: { id: add.record.id } });
  st = await readState(db, admin);
  assert.equal(st.extras.length, 1);
  const hist = await readHistory(db, b.id);
  assert.ok(hist.some((x) => x.entity === 'extra' && x.action === 'create'));
  // Prenotazione cancellata: niente nuovi extra
  const cur = await db.prepare('SELECT version FROM bookings WHERE id = ?').bind(b.id).first();
  await runOp(db, admin, { opId: op(), type: 'booking.cancel', payload: { id: b.id, version: cur.version } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'extra.add', payload: { bookingId: b.id, extra: { kind: 'tassa_soggiorno', amount_cents: 100 } } }), 'state');
});

test('contratto solo per le prenotazioni dirette: Airbnb e Booking concludono il check-in senza', async () => {
  const { db, admin } = await setup();
  const { record: b } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking({ channel: 'booking', check_in: T, check_out: addDays(T, 2) }) } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'booking.step', payload: { id: b.id, flow: 'checkin', step: 'contratto', done: true } }), 'validation');
  for (const step of ['ospiti', 'documenti', 'pagamenti', 'alloggiati', 'dms']) {
    await runOp(db, admin, { opId: op(), type: 'booking.step', payload: { id: b.id, flow: 'checkin', step, done: true } });
  }
  const r = await runOp(db, admin, { opId: op(), type: 'booking.checkin', payload: { id: b.id, version: b.version } });
  assert.equal(r.record.stage, 'in_casa');
});

test('tassa di soggiorno: persone, importo 0 per gli esenti, tariffe della casa solo dall’amministratore', async () => {
  const { db, admin, collab } = await setup();
  const { record: b } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking({ channel: 'booking' }) } });
  const t = await runOp(db, admin, { opId: op(), type: 'extra.add', payload: { bookingId: b.id, extra: { kind: 'tassa_soggiorno', persons: 0, amount_cents: 0, paid: 0 } } });
  assert.equal(t.record.amount_cents, 0);
  assert.equal(t.record.paid, 1, 'niente da incassare');
  const up = await runOp(db, admin, { opId: op(), type: 'extra.update', payload: { id: t.record.id, version: t.record.version, changes: { persons: 3, amount_cents: 2100, paid: 0 } } });
  assert.equal(up.record.persons, 3);
  assert.equal(up.record.paid, 0);
  await expectOpError(runOp(db, admin, { opId: op(), type: 'extra.update', payload: { id: t.record.id, version: up.record.version, changes: { kind: 'altro' } } }), 'validation');
  const house = await db.prepare("SELECT version, tourist_tax FROM houses WHERE id = 'isola-bella'").first();
  assert.deepEqual(JSON.parse(house.tourist_tax).rates, [0, 0, 0, 0, 50, 100, 100, 100, 100, 50, 0, 0]);
  const rates = [0, 0, 0, 0, 60, 120, 120, 120, 120, 60, 0, 0];
  await expectOpError(runOp(db, collab, { opId: op(), type: 'house.update', payload: { id: 'isola-bella', version: house.version, changes: { tourist_tax: { rates, max_nights: 7 } } } }), 'forbidden');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'house.update', payload: { id: 'isola-bella', version: house.version, changes: { tourist_tax: { rates: [1, 2], max_nights: null } } } }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'house.update', payload: { id: 'isola-bella', version: house.version, changes: { tourist_tax: { rates: rates.map(() => -1), max_nights: null } } } }), 'validation');
  const r = await runOp(db, admin, { opId: op(), type: 'house.update', payload: { id: 'isola-bella', version: house.version, changes: { tourist_tax: { rates, max_nights: 7 } } } });
  assert.deepEqual(JSON.parse(r.record.tourist_tax), { rates, max_nights: 7 });
});

test('spese della casa: aggiunta, modifica, pagata, eliminazione e ripristino; anche i collaboratori', async () => {
  const { db, admin, collab } = await setup();
  await expectOpError(runOp(db, collab, { opId: op(), type: 'expense.add', payload: { expense: { house_id: 'faro-blu', category: 'gas', amount_cents: 100, date: T } } }), 'validation');
  const luce = await runOp(db, collab, { opId: op(), type: 'expense.add', payload: { expense: { house_id: 'faro-blu', category: 'luce', amount_cents: 8450, date: T, period_from: '2026-07-01', period_to: '2026-08-31' } } });
  assert.equal(luce.record.category, 'luce');
  await runOp(db, collab, { opId: op(), type: 'expense.delete', payload: { id: luce.record.id } });
  await expectOpError(runOp(db, collab, { opId: op(), type: 'expense.add', payload: { expense: { house_id: 'nessuna', category: 'acquisti', amount_cents: 100, date: T } } }), 'validation');
  await expectOpError(runOp(db, collab, { opId: op(), type: 'expense.add', payload: { expense: { house_id: 'faro-blu', category: 'tari', amount_cents: 100, date: T, period_from: '2027-06-01', period_to: '2027-01-01' } } }), 'validation');
  const r = await runOp(db, collab, { opId: op(), type: 'expense.add', payload: { expense: {
    house_id: 'faro-blu', category: 'tari', label: '2a rata', amount_cents: 21600, date: T, due_date: addDays(T, 5), paid: 0 } } });
  assert.equal(r.record.paid, 0);
  assert.equal(r.record.paid_at, null);
  const up = await runOp(db, admin, { opId: op(), type: 'expense.update', payload: { id: r.record.id, version: r.record.version, changes: { paid: 1 } } });
  assert.equal(up.record.paid, 1);
  assert.ok(up.record.paid_at);
  await expectOpError(runOp(db, admin, { opId: op(), type: 'expense.update', payload: { id: r.record.id, version: r.record.version, changes: { amount_cents: 1 } } }), 'conflict');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'expense.update', payload: { id: r.record.id, version: up.record.version, changes: { deleted: 1 } } }), 'validation');
  const moved = await runOp(db, admin, { opId: op(), type: 'expense.update', payload: { id: r.record.id, version: up.record.version, changes: { house_id: 'isola-bella', amount_cents: 22000 } } });
  assert.equal(moved.record.house_id, 'isola-bella');
  assert.equal(moved.record.amount_cents, 22000);
  await runOp(db, collab, { opId: op(), type: 'expense.delete', payload: { id: r.record.id } });
  assert.equal((await readState(db, admin)).expenses.length, 0);
  await runOp(db, collab, { opId: op(), type: 'expense.restore', payload: { id: r.record.id } });
  assert.equal((await readState(db, collab)).expenses.length, 1, 'i collaboratori vedono le spese');
  // Spesa legata a un soggiorno: la prenotazione deve essere della stessa casa
  const { record: b } = await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'expense.add', payload: { expense: { house_id: 'isola-bella', category: 'pulizie', amount_cents: 5000, date: T, booking_id: b.id } } }), 'validation');
  const ok = await runOp(db, admin, { opId: op(), type: 'expense.add', payload: { expense: { house_id: b.house_id, category: 'pulizie', amount_cents: 5000, date: T, booking_id: b.id } } });
  assert.equal(ok.record.booking_id, b.id);
});

test('scadenze: le ricorrenti passano alla data successiva, le uniche si chiudono; visibili a tutti', async () => {
  const { db, admin, collab } = await setup();
  const { nextDue, deadlineStatus, deadlineAlerts } = await import('../public/shared/house.js');
  assert.equal(nextDue('2027-01-31', 'monthly'), '2027-02-28');
  assert.equal(nextDue('2027-11-30', 'quarterly'), '2028-02-29');
  assert.equal(nextDue('2028-02-29', 'yearly'), '2029-02-28');
  assert.equal(nextDue('2027-05-10', 'none'), null);
  await expectOpError(runOp(db, collab, { opId: op(), type: 'deadline.add', payload: { deadline: { title: '', due_date: T } } }), 'validation');
  await expectOpError(runOp(db, collab, { opId: op(), type: 'deadline.add', payload: { deadline: { title: 'X', due_date: T, repeat: 'weekly' } } }), 'validation');
  const r = await runOp(db, collab, { opId: op(), type: 'deadline.add', payload: { deadline: { title: 'Versamento tassa di soggiorno', due_date: addDays(T, 3), repeat: 'quarterly', notice_days: 10 } } });
  assert.equal(r.record.house_id, null);
  assert.equal(deadlineStatus(r.record, T).key, 'vicina');
  assert.equal(deadlineAlerts([r.record], T).length, 1);
  const d1 = await runOp(db, admin, { opId: op(), type: 'deadline.done', payload: { id: r.record.id, version: r.record.version } });
  assert.equal(d1.record.due_date, nextDue(addDays(T, 3), 'quarterly'));
  assert.equal(d1.record.done, 0);
  assert.ok(d1.record.last_done_at);
  assert.equal(deadlineAlerts([d1.record], T).length, 0, 'passata alla prossima: niente avviso');
  // Annulla: si torna alla data di prima
  const undo = await runOp(db, admin, { opId: op(), type: 'deadline.update', payload: { id: r.record.id, version: d1.record.version, changes: { due_date: addDays(T, 3) } } });
  assert.equal(undo.record.due_date, addDays(T, 3));
  const once = await runOp(db, admin, { opId: op(), type: 'deadline.add', payload: { deadline: { title: 'Rinnovo dominio', house_id: 'faro-blu', due_date: addDays(T, -2) } } });
  assert.equal(deadlineStatus(once.record, T).key, 'scaduta');
  assert.equal(deadlineAlerts([once.record], T)[0].level, 'urgente');
  const d2 = await runOp(db, admin, { opId: op(), type: 'deadline.done', payload: { id: once.record.id, version: once.record.version } });
  assert.equal(d2.record.done, 1);
  assert.equal(deadlineStatus(d2.record, T).key, 'fatta');
  assert.equal((await readState(db, collab)).deadlines.length, 2);
  const hist = (await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'deadline'").first()).n;
  assert.ok(hist >= 5, 'ogni modifica è nel registro');
});
