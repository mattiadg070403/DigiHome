import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, fmtRange, isIsoDate, overlaps, todayRome } from '../public/shared/dates.js';
import { fmtEuro, parseEuro, centsToInput } from '../public/shared/money.js';
import { balanceDue, bookingAlerts, currentAndNext, nextStep, phase, validateBooking, checkinSteps } from '../public/shared/booking.js';

const T = '2026-07-17';
const b = (over = {}) => ({
  id: 'x', house_id: 'faro-blu', channel: 'diretto', guest_name: 'Ospite', phone: '+39 1', guests: 4,
  check_in: addDays(T, 5), check_out: addDays(T, 12), arrival_time: null, total_cents: 100000, deposit_cents: 30000,
  deposit_paid: 1, security_cents: 30000, security_status: 'da_incassare', minors_delegation: 'non_serve',
  stage: 'confermata', checkin_steps: '{}', checkout_steps: '{}', ...over,
});

test('date: calcoli, cambio dell’ora legale, anni bisestili, sovrapposizioni', () => {
  assert.equal(addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(overlaps('2026-07-10', '2026-07-17', '2026-07-17', '2026-07-24'), false, 'giorno di cambio');
  assert.equal(overlaps('2026-07-10', '2026-07-18', '2026-07-17', '2026-07-24'), true);
  assert.equal(fmtRange('2026-07-28', '2026-08-04'), '28 luglio → 4 agosto');
  // A mezzanotte e mezza in Italia (22:30 UTC del giorno prima) è già il giorno dopo
  assert.equal(todayRome(new Date('2026-07-16T22:30:00Z')), '2026-07-17');
});

test('importi: scrittura italiana e inglese, errori', () => {
  assert.equal(parseEuro('1.150'), 115000);
  assert.equal(parseEuro('1150'), 115000);
  assert.equal(parseEuro('1150,5'), 115050);
  assert.equal(parseEuro('1.150,50'), 115050);
  assert.equal(parseEuro('1150.50'), 115050);
  assert.equal(parseEuro('€ 300'), 30000);
  assert.equal(parseEuro(''), 0);
  assert.equal(parseEuro('abc'), null);
  assert.equal(parseEuro('1,2,3'), null);
  assert.equal(parseEuro('-5'), null);
  assert.equal(parseEuro('12,345'), null);
  assert.equal(fmtEuro(115050), '1.150,50 €');
  assert.equal(fmtEuro(2450000), '24.500 €');
  assert.equal(centsToInput(115050), '1150,50');
});

test('fasi e prossimo passo', () => {
  assert.equal(phase(b(), T).label, 'Arriva tra 5 giorni');
  assert.equal(phase(b({ check_in: T }), T).key, 'arriva_oggi');
  assert.equal(phase(b({ check_in: addDays(T, -1) }), T).key, 'checkin_mancante');
  assert.equal(phase(b({ stage: 'in_casa', check_in: addDays(T, -2), check_out: T }), T).key, 'parte_oggi');
  assert.equal(nextStep(b({ check_in: addDays(T, 2) }), T).action, 'arrival');
  assert.equal(nextStep(b({ check_in: T }), T).action, 'checkin');
  assert.equal(nextStep(b({ stage: 'in_casa', check_in: addDays(T, -1), checkin_steps: '{}' }), T).action, 'alloggiati');
  assert.equal(nextStep(b({ stage: 'in_casa', check_in: addDays(T, -1), checkin_steps: '{"alloggiati":1}' }), T).action, 'checkout');
  assert.equal(nextStep(b({ stage: 'partita' }), T).action, 'close');
});

test('saldo da incassare', () => {
  assert.equal(balanceDue(b()), 70000);
  assert.equal(balanceDue(b({ deposit_paid: 0 })), 100000);
  assert.equal(balanceDue(b({ channel: 'airbnb' })), 0);
});

test('avvisi: cosa manca', () => {
  const list = bookingAlerts(b({ check_in: addDays(T, 2), phone: null, deposit_paid: 0 }), T).map((a) => a.text);
  assert.ok(list.includes('Manca l’orario di arrivo'));
  assert.ok(list.includes('Manca il numero di telefono'));
  assert.ok(list.includes('Acconto non ancora ricevuto'));
  const late = bookingAlerts(b({ check_in: addDays(T, -1) }), T);
  assert.equal(late[0].level, 'urgente');
  const clash = bookingAlerts(b(), T, [b(), b({ id: 'y', guest_name: 'Altro', check_in: addDays(T, 6) })]);
  assert.ok(clash.some((a) => a.text.startsWith('Date sovrapposte')));
  assert.deepEqual(bookingAlerts(b({ stage: 'chiusa' }), T), []);
});

test('scheda della casa: in corso e prossimo', () => {
  const list = [
    b({ id: 'old', stage: 'partita', check_in: addDays(T, -9), check_out: addDays(T, -2) }),
    b({ id: 'now', check_in: T, check_out: addDays(T, 7) }),
    b({ id: 'next', check_in: addDays(T, 9), check_out: addDays(T, 16) }),
  ];
  const { current, next } = currentAndNext(list, 'faro-blu', T);
  assert.equal(current.id, 'now', 'chi arriva oggi ha la precedenza su un soggiorno passato da chiudere');
  assert.equal(next.id, 'next');
});

test('validazione condivisa e passaggi del check-in', () => {
  assert.equal(validateBooking(b(), { house: { max_guests: 10 } }).ok, true);
  assert.ok(validateBooking(b({ guests: 11 }), { house: { max_guests: 10 } }).errors.guests);
  assert.ok(validateBooking(b({ email: 'non-una-email' }), {}).errors.email);
  assert.ok(validateBooking(b({ arrival_time: '25:00' }), {}).errors.arrival_time);
  assert.ok(validateBooking(b({ check_out: addDays(T, 200) }), {}).errors.check_out);
  assert.equal(checkinSteps(b()).some((s) => s.key === 'minori'), false);
  assert.equal(checkinSteps(b({ minors_delegation: 'da_chiedere' })).some((s) => s.key === 'minori'), true);
});

import { parseItDate, formatItDate, maskDate, maskTime, parseTime } from '../public/shared/dates.js';
import { occupiedNights, rangeFree, nextBlocked, arrivalReminders } from '../public/shared/booking.js';

test('date scritte a mano: maschera e lettura', () => {
  assert.equal(maskDate('08'), '08/');
  assert.equal(maskDate('0811'), '08/11/');
  assert.equal(maskDate('08112026'), '08/11/2026');
  assert.equal(maskDate('08/11/2026x9'), '08/11/2026');
  assert.equal(maskDate('08', true), '08', 'cancellando non rimette la barra');
  assert.equal(parseItDate('08/11/2026'), '2026-11-08');
  assert.equal(parseItDate('8/11/26'), '2026-11-08');
  assert.equal(parseItDate('31/02/2026'), null);
  assert.equal(parseItDate('08/13/2026'), null);
  assert.equal(formatItDate('2026-11-08'), '08/11/2026');
});

test('orari scritti a mano', () => {
  assert.equal(maskTime('16'), '16:');
  assert.equal(maskTime('1630'), '16:30');
  assert.equal(maskTime('16', true), '16');
  assert.equal(parseTime('1630'), '16:30');
  assert.equal(parseTime('9:05'), '09:05');
  assert.equal(parseTime('25:00'), null);
  assert.equal(parseTime('16:7'), null);
  assert.equal(parseTime(''), '');
});

test('disponibilità per il calendario', () => {
  const list = [
    { id: 'a', house_id: 'h', stage: 'confermata', check_in: '2026-07-10', check_out: '2026-07-13' },
    { id: 'b', house_id: 'h', stage: 'cancellata', check_in: '2026-07-20', check_out: '2026-07-25' },
    { id: 'c', house_id: 'altra', stage: 'confermata', check_in: '2026-07-01', check_out: '2026-07-30' },
  ];
  const occ = occupiedNights(list, 'h');
  assert.deepEqual([...occ], ['2026-07-10', '2026-07-11', '2026-07-12']);
  assert.equal(rangeFree(occ, '2026-07-05', '2026-07-10'), true, 'si può partire il giorno in cui arriva un altro');
  assert.equal(rangeFree(occ, '2026-07-13', '2026-07-15'), true, 'si può arrivare il giorno in cui parte un altro');
  assert.equal(rangeFree(occ, '2026-07-09', '2026-07-11'), false);
  assert.equal(nextBlocked(occ, '2026-07-05'), '2026-07-10');
  assert.equal(occupiedNights(list, 'h', 'a').size, 0, 'la prenotazione che si modifica non blocca sé stessa');
});

test('promemoria per l’arrivo', () => {
  const items = arrivalReminders(b({ guests: 4, linens: 1, towels: 0, deposit_paid: 1, security_cents: 30000, security_status: 'da_incassare', minors_delegation: 'da_chiedere' }), { checkin_time: '14:00' });
  assert.ok(items.includes('Lenzuola per 4 persone'));
  assert.ok(items.includes('Asciugamani non inclusi'));
  assert.ok(items.some((t) => t.startsWith('Da incassare: saldo 700 € + cauzione 300 €')));
  assert.ok(items.includes('Delega per i minorenni ancora da ricevere'));
  assert.ok(items.some((t) => t.includes('check-in dalle 14:00')));
  const airbnb = arrivalReminders(b({ channel: 'airbnb', security_cents: 0 }), {});
  assert.ok(airbnb.includes('Soggiorno già pagato su Airbnb'));
});

test('senza acconto non si segnala l’acconto mancante', () => {
  const x = b({ deposit_cents: 0, deposit_paid: 0, check_in: addDays(T, 3) });
  assert.ok(!bookingAlerts(x, T).some((a) => a.key === 'deposit'));
});
