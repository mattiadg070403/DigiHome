import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp, OpError } from '../src/ops.js';
import { addDays, todayRome } from '../public/shared/dates.js';
import { fmtKwh, meterCalc, meterMessage, parseKwh } from '../public/shared/meter.js';
import { checkinSteps, checkoutSteps } from '../public/shared/booking.js';

const T = todayRome();
const op = () => crypto.randomUUID();
const RULES = { kwh_day: 30, kwh_price_cents: 40 };

test('letture: numeri scritti all’italiana o all’inglese, in decimi di kWh', () => {
  assert.equal(parseKwh('12345'), 123450);
  assert.equal(parseKwh('12345,6'), 123456);
  assert.equal(parseKwh('12.345,6'), 123456);
  assert.equal(parseKwh('12.345'), 123450);
  assert.equal(parseKwh('12345.6'), 123456);
  assert.equal(parseKwh(' 12345 kWh '), 123450);
  for (const bad of ['', 'abc', '12,34', '1,2,3', '-5', '12.34.5']) assert.equal(parseKwh(bad), null, bad);
  assert.equal(fmtKwh(123456), '12.345,6');
  assert.equal(fmtKwh(123450), '12.345');
  assert.equal(fmtKwh(123456, 'en'), '12,345.6');
});

test('conti: kWh compresi per notte, soglia sul contatore, kWh in più e costo', () => {
  const b = { check_in: '2027-08-01', check_out: '2027-08-08', meter_start: 123450, meter_end: null };
  const a = meterCalc(b, RULES);
  assert.equal(a.included, 2100); // 30 × 7 = 210 kWh
  assert.equal(a.limit, 125550);
  assert.equal(a.used, null);
  const c = meterCalc({ ...b, meter_end: 126003 }, RULES); // 255,3 kWh usati
  assert.equal(c.used, 2553);
  assert.equal(c.extra, 453);
  assert.equal(c.cost, 1812); // 45,3 × 0,40 = 18,12 €
  assert.equal(meterCalc({ ...b, meter_end: 125000 }, RULES).cost, 0);
  assert.equal(meterCalc({ ...b, meter_end: 126003 }, {}).included, null);
});

test('messaggi per l’ospite: arrivo con la soglia, partenza con il conto (anche in inglese)', () => {
  const b = { guest_name: 'Marco Rossi', check_in: '2027-08-01', check_out: '2027-08-08', meter_start: 123450, meter_start_bands: '[40000,50000,33450]',
    meter_start_at: '2027-08-01T14:30:00Z', meter_end: 126003, meter_end_bands: '[41000,51000,34003]', meter_end_at: '2027-08-08T08:00:00Z' };
  const s = meterMessage('start', b, RULES);
  assert.match(s, /^Ciao Marco,/);
  assert.match(s, /all’arrivo \(01\/08\/2027 alle 16:30\):/);
  assert.match(meterMessage('start', { ...b, meter_start_bands: null }, RULES), /all’arrivo: 12\.345 kWh \(01\/08\/2027 alle 16:30\)/);
  assert.match(s, /A1: 4\.000 kWh\nA2: 5\.000 kWh\nA3: 3\.345 kWh\nTotale: 12\.345 kWh/);
  assert.match(s, /Sono compresi 30 kWh al giorno, cioè 210 kWh per le 7 notti/);
  assert.match(s, /il totale supera 12\.555 kWh, ogni kWh in più costa 0,40 €/);
  const e = meterMessage('end', b, RULES);
  assert.match(e, /alla partenza \(08\/08\/2027 alle 10:00\):/);
  assert.match(e, /All’arrivo il totale era 12\.345 kWh/);
  assert.match(e, /A3: 3\.400,3 kWh\nTotale: 12\.600,3 kWh/);
  assert.match(e, /45,3 kWh in più × 0,40 € = 18,12 €/);
  assert.match(meterMessage('end', { ...b, meter_end: 125000 }, RULES), /niente da pagare in più/);
  const en = meterMessage('start', b, RULES, 'en');
  assert.match(en, /^Hi Marco,/);
  assert.match(en, /on arrival \(01\/08\/2027 at 16:30\):\nA1: 4,000 kWh/);
  assert.match(en, /each extra kWh costs €0\.40/);
});

test('passaggi: niente gas, “Contatore della luce” al check-in e al check-out', () => {
  const b = { channel: 'diretto', guests: 2, minors_delegation: 'non_serve', security_cents: 0 };
  assert.match(checkinSteps(b).find((s) => s.key === 'contatori').title, /Contatore della luce/);
  assert.doesNotMatch(JSON.stringify([...checkinSteps(b), ...checkoutSteps(b)]), /gas/);
});

async function setup(channel = 'diretto') {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', name: 'Mattia', role: 'admin' });
  const b = (await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: {
    house_id: 'faro-blu', channel, guest_name: 'Anna Verdi', phone: '+39 000 000', guests: 4,
    check_in: addDays(T, -3), check_out: addDays(T, 4), total_cents: 100000, deposit_cents: 0, security_cents: 0,
  } } })).record;
  return { db, admin, b };
}

test('server: lettura all’arrivo e alla partenza, extra della luce aggiornato o tolto (prenotazione diretta)', async () => {
  const { db, admin, b } = await setup();
  const r1 = await runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'start', bands: [40000, 30000, 30000] } });
  assert.equal(r1.record.meter_start, 100000);
  assert.deepEqual(JSON.parse(r1.record.meter_start_bands), [40000, 30000, 30000]);
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'start', bands: [1, 2] } }), /tre fasce/);
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'start', value: 5 } }), /tre fasce/);
  assert.ok(r1.record.meter_start_at);
  assert.equal(JSON.parse(r1.record.checkin_steps).contatori, 1);
  // La partenza si scrive al check-out.
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'end', bands: [41000, 31000, 31000] } }), /check-out/);
  await db.prepare("UPDATE bookings SET stage = 'in_casa' WHERE id = ?").bind(b.id).run();
  // Più bassa della lettura di arrivo: rifiutata.
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'end', bands: [39999, 30000, 30000] } }), /più bassa/);
  // 7 notti × 30 = 210 kWh compresi; usati 300 → 90 in più × 0,40 = 36 €.
  const r2 = await runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'end', bands: [41000, 31000, 31000] } });
  assert.equal(JSON.parse(r2.record.checkout_steps).contatori, 1);
  const extra = r2.related.find(([e]) => e === 'extra')[1];
  assert.equal(extra.kind, 'luce');
  assert.equal(extra.amount_cents, 3600);
  assert.equal(extra.label, '90 kWh oltre i 210 compresi');
  // Correzione: 250 kWh usati → 40 in più = 16 €, stesso extra.
  const r3 = await runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'end', bands: [41000, 30500, 31000] } });
  assert.equal(r3.related[0][1].id, extra.id);
  assert.equal(r3.related[0][1].amount_cents, 1600);
  // Entro i compresi: l'extra si toglie.
  const r4 = await runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'end', bands: [40500, 30000, 30500] } });
  assert.equal(r4.related[0][1].deleted, 1);
  // Valori non validi
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'end', bands: [-1, 0, 0] } }), OpError);
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'gas', bands: [1, 1, 1] } }), OpError);
  // Gli utenti non possono creare a mano un extra "luce".
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'extra.add', payload: { bookingId: b.id, extra: { kind: 'luce', amount_cents: 100 } } }), OpError);
});

test('server: con Airbnb e Booking la lettura si salva ma l’extra non si aggiunge da solo', async () => {
  const { db, admin, b } = await setup('airbnb');
  await runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'start', bands: [40000, 30000, 30000] } });
  await db.prepare("UPDATE bookings SET stage = 'in_casa' WHERE id = ?").bind(b.id).run();
  const r = await runOp(db, admin, { opId: op(), type: 'booking.meter', payload: { id: b.id, which: 'end', bands: [42000, 32000, 31000] } });
  assert.deepEqual(r.related, []);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM booking_extras WHERE kind = 'luce'").first();
  assert.equal(n.n, 0);
});
