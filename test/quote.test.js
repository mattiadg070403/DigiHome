import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp, OpError } from '../src/ops.js';
import { readState } from '../src/state.js';
import {
  DEFAULT_QUOTE, checkQuoteSettings, depositFor, extraAmount, historyPrice, quoteChecks, quoteMessage, quoteSettings, rangeText, suggestPrice,
} from '../public/shared/quote.js';

const TAX = { rates: [0, 0, 0, 0, 50, 100, 100, 100, 100, 50, 0, 0], max_nights: null };
const HOUSE = { id: 'faro-blu', name: 'Faro Blu', max_guests: 10, checkin_time: '14:00', checkout_time: '10:00' };
const S = quoteSettings({});
const bk = (check_in, check_out, total_cents, over = {}) => ({ id: `${check_in}-${total_cents}`, house_id: 'faro-blu', stage: 'chiusa', channel: 'diretto', guests: 6, check_in, check_out, total_cents, ...over });

test('storico: media a notte pesata sui giorni nel periodo simile, solo anni passati e soggiorni con prezzo', () => {
  const list = [
    bk('2025-08-20', '2025-08-27', 210000), // 300 €/notte, tutto nel periodo
    bk('2024-08-24', '2024-08-31', 140000), // 200 €/notte
    bk('2025-06-01', '2025-06-08', 70000), // fuori periodo
    bk('2025-08-22', '2025-08-29', 0), // senza prezzo (da completare)
    bk('2025-08-22', '2025-08-29', 999900, { stage: 'cancellata' }),
    bk('2025-08-22', '2025-08-29', 999900, { house_id: 'isola-bella' }),
    bk('2026-08-20', '2026-08-27', 999900), // stesso anno del preventivo: non è storico
  ];
  const h = historyPrice(list, 'faro-blu', '2026-08-25', '2026-08-31', { windowDays: 20, today: '2026-11-14' });
  assert.equal(h.count, 2);
  assert.equal(h.perNight, 25000);
  assert.equal(historyPrice([], 'faro-blu', '2026-08-25', '2026-08-31', { today: '2026-11-14' }).perNight, null);
});

test('prezzo consigliato: correzioni (soggiorno lungo, anticipo, ultimo minuto) e arrotondamento a 10 €', () => {
  const hist = { perNight: 27500, count: 3 };
  const a = suggestPrice(hist, { checkIn: '2027-08-25', checkOut: '2027-08-31', today: '2026-11-14', settings: S });
  assert.deepEqual(a.adjustments.map((x) => x.pct), [5]);
  assert.equal(a.total, 173000); // 6 × 275 = 1650 → +5% = 1732,5 → 1730
  const b = suggestPrice(hist, { checkIn: '2026-11-20', checkOut: '2026-12-05', today: '2026-11-14', settings: S });
  assert.deepEqual(b.adjustments.map((x) => x.pct), [-10, -10]);
  const c = suggestPrice(hist, { checkIn: '2027-03-01', checkOut: '2027-03-04', today: '2026-11-14', settings: S });
  assert.deepEqual(c.adjustments, []);
  assert.equal(c.total, 83000); // 3 × 275 = 825 → 830
  assert.equal(suggestPrice({ perNight: null }, { checkIn: '2027-03-01', checkOut: '2027-03-04', today: '2026-11-14', settings: S }), null);
});

test('acconto 30% arrotondato a 50 €; extra per persona, notte, soggiorno', () => {
  assert.equal(depositFor(165000, 30), 50000);
  assert.equal(depositFor(120000, 30), 35000);
  assert.equal(depositFor(10000, 30), 5000);
  assert.equal(depositFor(0, 30), 0);
  const g = DEFAULT_QUOTE.extras[0];
  assert.equal(extraAmount(g, { guests: 9, nights: 6 }), 9000);
  assert.equal(extraAmount({ ...g, unit: 'notte' }, { guests: 9, nights: 6 }), 6000);
  assert.equal(extraAmount({ ...g, unit: 'soggiorno' }, { guests: 9, nights: 6 }), 1000);
});

test('controlli: date occupate, minimo di notti in alta stagione, notti scoperte, troppe persone', () => {
  const list = [bk('2027-08-01', '2027-08-08', 1), bk('2027-08-11', '2027-08-18', 1)];
  const c1 = quoteChecks(list, HOUSE, S, { checkIn: '2027-08-05', checkOut: '2027-08-10', guests: 4, today: '2026-11-14' });
  assert.ok(c1.some((x) => x.level === 'bad' && /occupate/.test(x.text)));
  const c2 = quoteChecks(list, HOUSE, S, { checkIn: '2027-08-08', checkOut: '2027-08-10', guests: 12, today: '2026-11-14' });
  assert.ok(c2.some((x) => /minimo è 5 notti/.test(x.text)));
  assert.ok(c2.some((x) => /Dopo restano 1 notte/.test(x.text)));
  assert.ok(c2.some((x) => /al massimo 10 persone/.test(x.text)));
  const c3 = quoteChecks(list, HOUSE, S, { checkIn: '2027-09-10', checkOut: '2027-09-13', guests: 4, today: '2026-11-14' });
  assert.deepEqual(c3.map((x) => x.level), ['ok']);
});

test('messaggio: come quello di Mattia, con tassa a parte, extra, acconto e saldo; anche in inglese', () => {
  const garage = { ...DEFAULT_QUOTE.extras[0], amount: 9000 };
  const q = { lang: 'it', name: 'Marco Rossi', checkIn: '2026-08-25', checkOut: '2026-08-31', guests: 9, price: 165000, deposit: 50000,
    security: 25000, linens: true, towels: false, extras: [garage], validUntil: '2026-11-21' };
  const info = { kwh_day: 30, kwh_price_cents: 40 };
  const it = quoteMessage(q, HOUSE, info, TAX);
  for (const re of [/Ciao Marco, ecco il preventivo per Faro Blu/, /Date: 25–31 agosto 2026 \(6 notti\)/, /Ospiti: 9/, /\*Prezzo: 1\.650 €\*/,
    /lenzuola per ogni letto \(asciugamani non inclusi\)/, /30 kWh al giorno.*0,40 €\/kWh/, /tassa di soggiorno: 54 € \(1 € a persona a notte\)/,
    /garage: 90 € \(10 € a persona per tutto il soggiorno\)/, /cauzione: 250 €/, /\*Bonifico acconto: 500 €\* \(non rimborsabile\)/,
    /Saldo all’arrivo: 1\.150 € \+ 250 € di cauzione \+ 54 € di tassa di soggiorno \+ 90 € di garage/, /valido fino al 21 novembre/]) {
    assert.match(it, re);
  }
  assert.doesNotMatch(it, /gas/i);
  const en = quoteMessage({ ...q, lang: 'en' }, HOUSE, info, TAX);
  for (const re of [/Hi Marco, here is the quote/, /August 25–31, 2026 \(6 nights\)/, /\*Price: €1,650\*/, /tourist tax: €54/, /Balance on arrival: €1,150/]) assert.match(en, re);
  // Senza acconto, senza cauzione, fuori stagione (niente tassa)
  const off = quoteMessage({ ...q, checkIn: '2027-01-10', checkOut: '2027-01-12', deposit: 0, security: 0, extras: [] }, HOUSE, info, TAX);
  assert.match(off, /Pagamento all’arrivo: 1\.650 €/);
  assert.doesNotMatch(off, /A parte:|tassa/);
  assert.equal(rangeText('2026-07-28', '2026-08-04'), '28 luglio – 4 agosto 2026');
  assert.equal(rangeText('2026-12-28', '2027-01-03', 'en'), 'December 28, 2026 – January 3, 2027');
});

test('impostazioni dei preventivi: controlli', () => {
  assert.equal(checkQuoteSettings({ ...DEFAULT_QUOTE }).ok, true);
  assert.equal(checkQuoteSettings({ ...DEFAULT_QUOTE, validity_days: 0 }).field, 'validity_days');
  assert.equal(checkQuoteSettings({ ...DEFAULT_QUOTE, min_nights: [1, 2] }).field, 'min_nights');
  assert.equal(checkQuoteSettings({ ...DEFAULT_QUOTE, extras: [{ label: 'Transfer', price_cents: 5000, unit: 'volo' }] }).field, 'extras');
  assert.equal(checkQuoteSettings({ ...DEFAULT_QUOTE, long_stay: [{ nights: 7, pct: 80 }] }).field, 'long_stay');
  const dup = checkQuoteSettings({ ...DEFAULT_QUOTE, extras: [{ label: 'Garage', price_cents: 1, unit: 'soggiorno' }, { label: 'Garage', price_cents: 2, unit: 'soggiorno' }] });
  assert.notEqual(dup.value.extras[0].id, dup.value.extras[1].id);
  assert.deepEqual(quoteSettings({ quote_settings: '{rotto' }), DEFAULT_QUOTE);
});

test('server: impostazioni salvate solo dall’amministratore; ai collaboratori le regole della luce ma non i dati del locatore', async () => {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', name: 'Mattia', role: 'admin' });
  const collab = await addUser(db, { email: 'collab@example.invalid', name: 'Collab', role: 'collaboratore' });
  const h = await db.prepare("SELECT * FROM houses WHERE id = 'faro-blu'").first();
  assert.equal(quoteSettings(h).extras[0].label, 'Garage');
  const qs = { ...quoteSettings(h), validity_days: 10 };
  await assert.rejects(runOp(db, collab, { opId: crypto.randomUUID(), type: 'house.update', payload: { id: 'faro-blu', version: h.version, changes: { quote_settings: qs } } }), OpError);
  await assert.rejects(runOp(db, admin, { opId: crypto.randomUUID(), type: 'house.update', payload: { id: 'faro-blu', version: h.version, changes: { quote_settings: { ...qs, validity_days: 99 } } } }), /Validità/);
  const info = { ...JSON.parse(h.contract_info), landlord_name: 'Mario Rossi', landlord_residence: 'Via Segreta 1' };
  const r = await runOp(db, admin, { opId: crypto.randomUUID(), type: 'house.update', payload: { id: 'faro-blu', version: h.version, changes: { quote_settings: qs, contract_info: info } } });
  assert.equal(JSON.parse(r.record.quote_settings).validity_days, 10);
  const st = await readState(db, collab);
  const fb = st.houses.find((x) => x.id === 'faro-blu');
  assert.deepEqual(JSON.parse(fb.contract_public), { city: 'Gallipoli', kwh_day: 30, kwh_price_cents: 40, advance_pct: 30 });
  assert.doesNotMatch(JSON.stringify(fb), /Mario Rossi|Via Segreta/);
});
