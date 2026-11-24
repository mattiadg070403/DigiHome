import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACCOUNTING } from '../public/shared/accounting.js';
import {
  DEFAULT_PRICING, bookingPace, bookedOn, buildList, channelPrices, checkPricingSettings, checkWeekChanges,
  directPriceFromList, pricingSettings, seasonWeeks, seasonYear, weekHistory, weekSuggestion,
} from '../public/shared/pricing.js';
import { weekday } from '../public/shared/dates.js';

const acc = JSON.parse(JSON.stringify(DEFAULT_ACCOUNTING));
const house = { id: 'faro-blu', accounting: JSON.stringify(acc), pricing: null };
const S = pricingSettings(house);

test('prezzi per canale: in tasca resta lo stesso netto (conti dello screenshot di Mattia)', () => {
  // 79 € a notte in tasca = 100 € in diretta (cedolare 21%).
  const p = channelPrices(79 * 7 * 100, { acc, date: '2027-06-05' });
  assert.equal(p.diretto.night, 10000);
  // Airbnb 15,5% + IVA = 18,91%: 79 / (1 − 0,1891 − 0,21) = 131,47 → 132 € a notte (arrotondato in su).
  assert.equal(p.airbnb.commissionBp, 1891);
  assert.equal(p.airbnb.night, 13200);
  assert.equal(p.airbnb.week, 92400);
  // Booking: 16,16% (dalla contabilità) → 79 / 0,6284 = 125,72 → 126 €.
  assert.equal(p.booking.night, 12600);
  // Con l'arrotondamento in su il netto vero non scende mai sotto quello scelto.
  for (const ch of ['diretto', 'airbnb', 'booking']) assert.ok(p[ch].keepWeek >= 79 * 7 * 100, ch);
  // Controllo inverso come nello screenshot: 100 € su Airbnb lasciano 60,09 €.
  assert.equal(Math.round(10000 * (10000 - 1891 - 2100) / 10000), 6009);
});

test('prezzi per canale: commissione valida in quella data e sconto attivo sul portale', () => {
  const old = channelPrices(70000, { acc, date: '2026-06-06' }); // Airbnb al 3% + IVA prima del 13/10/2026
  assert.equal(old.airbnb.commissionBp, 366);
  const genius = channelPrices(70000, { acc, date: '2027-06-05', discounts: { booking: 10 } });
  const plain = channelPrices(70000, { acc, date: '2027-06-05' });
  assert.ok(genius.booking.night > plain.booking.night);
  assert.ok(genius.booking.keepWeek >= 70000); // dopo lo sconto Genius in tasca resta comunque il netto
  assert.equal(channelPrices(0, { acc, date: '2027-06-05' }).diretto, null);
});

test('settimane della stagione: da sabato, giugno–settembre, almeno 4 notti dentro', () => {
  const w = seasonWeeks(2027, S);
  assert.ok(w.every((d) => weekday(d) === 6));
  assert.equal(w[0], '2027-05-29'); // 29/5–5/6: 4 notti a giugno (1–4 giugno) → conta
  assert.equal(w.at(-1), '2027-09-25'); // 25/9–2/10: 5 notti a settembre
  assert.equal(w.length, 18);
  const sunday = seasonWeeks(2027, { ...S, week_start: 0 });
  assert.ok(sunday.every((d) => weekday(d) === 0));
  assert.equal(seasonYear('2026-11-23', S), 2027);
  assert.equal(seasonYear('2027-03-01', S), 2027);
  assert.equal(seasonYear('2027-09-30', S), 2027);
});

test('impostazioni: valori di partenza e controlli', () => {
  assert.deepEqual(pricingSettings({}), DEFAULT_PRICING);
  assert.equal(checkPricingSettings({ ...DEFAULT_PRICING, months: [9, 6] }).ok, false);
  assert.equal(checkPricingSettings({ ...DEFAULT_PRICING, discounts: { airbnb: 60 } }).ok, false);
  assert.equal(checkPricingSettings({ ...DEFAULT_PRICING, last_minute: [{ days: 30, pct: 5 }, { days: 30, pct: 10 }] }).ok, false);
  const ok = checkPricingSettings({ ...DEFAULT_PRICING, last_minute: [{ days: 14, pct: 15 }, { days: 45, pct: 5 }, { days: 20, pct: 0 }] });
  assert.deepEqual(ok.value.last_minute.map((x) => x.days), [45, 14]); // ordinati, quelli a 0% tolti
  assert.equal(checkWeekChanges(2027, { '2027-06-05': 150000, '2027-06-12': null }).ok, true);
  assert.equal(checkWeekChanges(2027, { '2025-06-05': 150000 }).ok, false);
  assert.equal(checkWeekChanges(2027, { '2027-06-05': 50 }).ok, false);
  assert.equal(checkWeekChanges(2027, { '2027-06-05': 1.5 }).ok, false);
});

const stay = (o) => ({ house_id: 'faro-blu', stage: 'chiusa', channel: 'diretto', guests: 4, created_at: '2026-01-10T10:00:00Z', ...o });

test('storico: netto in tasca della stessa settimana dell’anno scorso, con le regole di allora', () => {
  const bookings = [
    stay({ id: 'a', check_in: '2026-06-06', check_out: '2026-06-13', total_cents: 140000 }), // diretto: 1400 − 21% = 1106
    stay({ id: 'b', channel: 'airbnb', check_in: '2026-06-13', check_out: '2026-06-16', total_cents: 60000 }),
  ];
  const h = weekHistory(bookings, house, '2027-06-05');
  assert.equal(h.net, 110600);
  assert.equal(h.nights, 7);
  const h2 = weekHistory(bookings, house, '2027-06-12');
  // 3 notti Airbnb (al 3% + IVA prima di ottobre 2026): 600 − 21,96 − 126 = 452,04 → 150,68 a notte → ×7
  assert.equal(h2.nights, 3);
  assert.equal(h2.net, Math.round(((60000 - Math.round(60000 * 0.0366) - 12600) / 3) * 7));
  assert.equal(weekHistory(bookings, house, '2027-07-03'), null);
});

test('data di prenotazione: "prenotata il", altrimenti inserimento prima dell’arrivo; importate dopo = sconosciuta', () => {
  assert.equal(bookedOn({ booked_on: '2026-02-01', check_in: '2026-07-01' }), '2026-02-01');
  assert.equal(bookedOn({ created_at: '2026-02-03T09:00:00Z', check_in: '2026-07-01' }), '2026-02-03');
  assert.equal(bookedOn({ created_at: '2026-11-20T09:00:00Z', check_in: '2026-07-01' }), null);
});

test('ritmo: notti vendute oggi contro quelle vendute a questa data l’anno scorso', () => {
  const today = '2027-03-01';
  const bookings = [
    // Anno scorso, luglio: 14 notti prenotate prima del 1/3/2026, 7 dopo.
    stay({ id: '1', check_in: '2026-07-04', check_out: '2026-07-11', booked_on: '2026-01-15' }),
    stay({ id: '2', check_in: '2026-07-11', check_out: '2026-07-18', booked_on: '2026-02-20' }),
    stay({ id: '3', check_in: '2026-07-18', check_out: '2026-07-25', booked_on: '2026-04-02' }),
    // Quest'anno, luglio: solo 7 notti.
    stay({ id: '4', stage: 'confermata', check_in: '2027-07-03', check_out: '2027-07-10', booked_on: '2027-02-10' }),
    // Cancellata: non conta.
    stay({ id: '5', stage: 'cancellata', check_in: '2027-07-10', check_out: '2027-07-17', booked_on: '2027-02-11' }),
  ];
  const pace = bookingPace(bookings, 'faro-blu', 2027, S, today);
  const jul = pace.find((x) => x.month === 7);
  assert.equal(jul.sold, 7);
  assert.equal(jul.ly, 14);
  assert.equal(jul.pct, 23);
  assert.equal(jul.lyPct, 45);
  assert.equal(jul.status, 'indietro');
  assert.equal(jul.lyFinalPct, 68);
  // Giugno: niente l'anno scorso → non confrontabile.
  assert.equal(pace.find((x) => x.month === 6).status, null);
  // Anno scorso con prenotazioni senza data (importate dopo): non si confronta.
  const unknown = bookingPace([stay({ id: 'x', check_in: '2026-07-04', check_out: '2026-07-11', created_at: '2026-11-01T00:00:00Z' })], 'faro-blu', 2027, S, today);
  assert.equal(unknown.find((x) => x.month === 7).status, null);
});

test('suggerimenti: niente sconti presto, ultimo minuto vicino all’arrivo, ritmo, mai sotto il minimo', () => {
  const base = { net: 150000, lyNet: 140000, sold: 0, settings: S };
  // Settimana già venduta o passata: niente.
  assert.equal(weekSuggestion({ ...base, ws: '2027-07-03', sold: 7, today: '2027-06-20' }), null);
  assert.equal(weekSuggestion({ ...base, ws: '2027-07-03', today: '2027-07-03' }), null);
  // Lontana (oltre 90 giorni) e ritmo lento: si tiene il prezzo.
  const slow = { month: 7, status: 'indietro', pct: 10, lyPct: 40 };
  assert.equal(weekSuggestion({ ...base, ws: '2027-07-03', today: '2027-02-01', pace: slow }), null);
  // Lontana e ritmo veloce: +5%.
  const fast = { month: 7, status: 'avanti', pct: 60, lyPct: 30 };
  const up = weekSuggestion({ ...base, ws: '2027-07-03', today: '2027-02-01', pace: fast });
  assert.equal(up.pct, 5);
  assert.equal(up.target, 158000); // 1.575 € arrotondato a 10 €
  // A 25 giorni: −10% (scaglione 30 giorni), più −5% se il mese va lento.
  const lm = weekSuggestion({ ...base, ws: '2027-07-03', today: '2027-06-08', pace: slow });
  assert.deepEqual(lm.reasons.map((r) => r.pct), [-10, -5]);
  assert.equal(lm.target, 128000); // 1.275 € → 1.280 €
  // Minimo netto: non si scende sotto.
  const floor = weekSuggestion({ ...base, ws: '2027-07-03', today: '2027-06-25', settings: { ...S, floor_cents: 140000 } });
  assert.equal(floor.target, 140000);
  // Manca il prezzo: si propone quello dell'anno scorso.
  const miss = weekSuggestion({ ...base, net: null, ws: '2027-07-03', today: '2027-01-10' });
  assert.equal(miss.missing, true);
  assert.equal(miss.target, 140000);
});

test('listino completo e prezzo del preventivo dal listino (soggiorni a cavallo di due settimane)', () => {
  const prices = [{ house_id: 'faro-blu', year: 2027, weeks: JSON.stringify({ '2027-07-03': 140000, '2027-07-10': 175000 }) }];
  const list = buildList({ bookings: [], prices, house, year: 2027, today: '2026-11-23' });
  const w = list.weeks.find((x) => x.ws === '2027-07-03');
  assert.equal(w.net, 140000);
  assert.equal(w.prices.diretto.night, 25400); // 200 € a notte in tasca → 253,16 → 254 €
  // Dal 7 al 14 luglio: 3 notti della prima settimana + 4 della seconda.
  const weeks = { '2027-07-03': 140000, '2027-07-10': 175000 };
  const r = directPriceFromList(weeks, { checkIn: '2027-07-07', checkOut: '2027-07-14', acc });
  assert.equal(r.total, 3 * 25400 + 4 * 31700); // 250 € netti → 316,46 → 317 €
  assert.deepEqual(r.weeks, ['2027-07-03', '2027-07-10']);
  // Una notte senza listino: niente prezzo dal listino.
  assert.equal(directPriceFromList(weeks, { checkIn: '2027-07-15', checkOut: '2027-07-20', acc }), null);
});

test('operazioni: listino solo per l’amministratore, settimane unite, registro senza dati personali', async () => {
  const { freshDb, addUser } = await import('./d1.js');
  const { runOp } = await import('../src/ops.js');
  const { readState } = await import('../src/state.js');
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', role: 'admin' });
  const collab = await addUser(db, { email: 'collab@example.invalid', role: 'collaboratore' });
  const op = (user, payload) => runOp(db, user, { opId: crypto.randomUUID(), type: 'price.set', payload });
  await assert.rejects(op(admin, { house_id: 'casa-x', year: 2027, weeks: { '2027-06-05': 150000 } }), /Casa non trovata/);
  await assert.rejects(op(admin, { house_id: 'faro-blu', year: 2027, weeks: { '2027-06-05': -5 } }), /non valido/);
  const a = await op(admin, { house_id: 'faro-blu', year: 2027, weeks: { '2027-06-05': 150000, '2027-06-12': 160000 } });
  assert.equal(a.record.id, 'faro-blu:2027');
  const b = await op(admin, { house_id: 'faro-blu', year: 2027, weeks: { '2027-06-12': 170000, '2027-06-05': null, '2027-06-19': 180000 } });
  assert.deepEqual(JSON.parse(b.record.weeks), { '2027-06-12': 170000, '2027-06-19': 180000 });
  assert.equal(b.record.version, 2);
  const same = await op(admin, { house_id: 'faro-blu', year: 2027, weeks: { '2027-06-12': 170000 } });
  assert.equal(same.unchanged, true);
  // Lo vedono e lo cambiano tutti (le impostazioni del listino invece solo l'amministratore).
  const st = await readState(db, collab);
  assert.equal(st.prices.length, 1);
  // Impostazioni del listino: controllate dal server.
  const h = await db.prepare("SELECT version FROM houses WHERE id = 'faro-blu'").first();
  await assert.rejects(runOp(db, admin, { opId: crypto.randomUUID(), type: 'house.update', payload: { id: 'faro-blu', version: h.version, changes: { pricing: { ...DEFAULT_PRICING, months: [9, 6] } } } }), /Stagione/);
  const ok = await runOp(db, admin, { opId: crypto.randomUUID(), type: 'house.update', payload: { id: 'faro-blu', version: h.version, changes: { pricing: { ...DEFAULT_PRICING, week_start: 0 } } } });
  assert.equal(JSON.parse(ok.record.pricing).week_start, 0);
});

test('prenotazione nuova: si segna il giorno in cui è arrivata (per il ritmo)', async () => {
  const { freshDb, addUser } = await import('./d1.js');
  const { runOp } = await import('../src/ops.js');
  const { todayRome } = await import('../public/shared/dates.js');
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', role: 'admin' });
  const r = await runOp(db, admin, { opId: crypto.randomUUID(), type: 'booking.create', payload: { booking: {
    house_id: 'faro-blu', channel: 'diretto', guest_name: 'Prova', guests: 2, check_in: '2030-07-06', check_out: '2030-07-13', total_cents: 150000 } } });
  assert.equal(r.record.booked_on, todayRome());
  const imp = await runOp(db, admin, { opId: crypto.randomUUID(), type: 'booking.import', payload: { rows: [
    { house_id: 'faro-blu', channel: 'airbnb', guests: 4, check_in: '2025-07-05', check_out: '2025-07-12', total_cents: 140000, booked_on: '2025-02-14' },
    { house_id: 'faro-blu', channel: 'airbnb', guests: 4, check_in: '2025-07-12', check_out: '2025-07-19', total_cents: 140000, booked_on: '2025-08-01' },
  ] } });
  assert.equal(imp.imported, 2);
  const rows = (await db.prepare("SELECT check_in, booked_on FROM bookings WHERE check_in < '2026-01-01' ORDER BY check_in").all()).results;
  assert.deepEqual(rows.map((x) => x.booked_on), ['2025-02-14', null]); // dopo l'arrivo: data impossibile, non si usa
});
