import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp, OpError } from '../src/ops.js';
import { readState } from '../src/state.js';
import {
  DEFAULT_ACCOUNTING, accountingSettings, accountingTodo, channelRule, checkAccountingSettings, checkRemittance, effectiveBp,
  expenseYear, stayAccount, yearReport,
} from '../public/shared/accounting.js';

const S = accountingSettings({});
const HOUSE = { id: 'faro-blu', name: 'Faro Blu' };
let seq = 0;
const bk = (over) => ({
  id: `b${++seq}`, house_id: 'faro-blu', channel: 'diretto', stage: 'chiusa', guest_name: `Ospite ${seq}`, guests: 4,
  check_in: '2026-08-01', check_out: '2026-08-08', total_cents: 0, deposit_cents: 0, deposit_paid: 0,
  security_cents: 0, security_status: 'nessuna', security_withheld_cents: 0, checkin_steps: '{"pagamenti":1}', ...over,
});

test('regole per canale con la data da cui valgono: Airbnb 3% + IVA, poi 15,5% + IVA, ritenuta dal 2027; Booking sempre trattenuta', () => {
  assert.deepEqual(channelRule(S, 'diretto', '2026-08-01'), { pct_bp: 0, vat: false, withheld: false });
  assert.equal(channelRule(S, 'airbnb', '2026-10-12').pct_bp, 300);
  assert.equal(channelRule(S, 'airbnb', '2026-10-13').pct_bp, 1550);
  assert.equal(channelRule(S, 'airbnb', '2026-12-31').withheld, false);
  assert.equal(channelRule(S, 'airbnb', '2027-01-01').withheld, true);
  assert.equal(channelRule(S, 'booking', '2025-07-01').withheld, true);
  assert.equal(effectiveBp({ pct_bp: 1550, vat: true }), 1891); // 15,5% + 22% di IVA = 18,91%
});

test('Booking: l’esempio di Mattia (2.944 € → circa 475,86 € di commissioni), ritenuta trattenuta, netto atteso', () => {
  const a = stayAccount(bk({ channel: 'booking', total_cents: 294400, payout_cents: 185000 }), { settings: S });
  assert.equal(a.commission, 47575); // 16,16% di 2.944 € (≈ 475,86 € del resoconto)
  assert.equal(a.cedolare, 61824); // 21% del solo prezzo
  assert.equal(a.withheld, 61824);
  assert.equal(a.cedolareToPay, 0);
  assert.equal(a.expectedPayout, 294400 - 47575 - 61824);
  assert.equal(a.payoutDiff, 185000 - (294400 - 47575 - 61824));
});

test('Airbnb 2026: commissione bassa e cedolare da versare; dal 2027 ritenuta trattenuta', () => {
  const a26 = stayAccount(bk({ channel: 'airbnb', total_cents: 100000, check_in: '2026-08-01' }), { settings: S });
  assert.equal(a26.commission, 3660);
  assert.equal(a26.cedolareToPay, 21000);
  assert.equal(a26.expectedPayout, 100000 - 3660);
  const a27 = stayAccount(bk({ channel: 'airbnb', total_cents: 100000, check_in: '2027-08-01', check_out: '2027-08-08' }), { settings: S });
  assert.equal(a27.commission, 18910);
  assert.equal(a27.withheld, 21000);
  assert.equal(a27.expectedPayout, 100000 - 18910 - 21000);
});

test('diretta: extra pieni (senza cedolare), tassa di soggiorno fuori, cauzione trattenuta come ricavo, costi del soggiorno, margine', () => {
  const b = bk({ total_cents: 150000, security_cents: 25000, security_status: 'trattenuta', security_withheld_cents: 8000 });
  const extras = [
    { booking_id: b.id, kind: 'altro', amount_cents: 9000, paid: 1 },
    { booking_id: b.id, kind: 'luce', amount_cents: 1600, paid: 0 },
    { booking_id: b.id, kind: 'tassa_soggiorno', amount_cents: 2800, paid: 1 },
    { booking_id: b.id, kind: 'altro', amount_cents: 5000, paid: 1, deleted: 1 },
  ];
  const expenses = [{ booking_id: b.id, category: 'pulizie', amount_cents: 6000, paid: 0, date: '2026-08-08' }];
  const a = stayAccount(b, { extras, expenses, settings: S });
  assert.equal(a.commission, 0);
  assert.equal(a.cedolare, 31500); // 21% di 1.500 €, non degli extra né della tassa
  assert.equal(a.cedolareToPay, 31500);
  assert.equal(a.extras, 10600);
  assert.equal(a.extrasUnpaid, 1600);
  assert.equal(a.tax, 2800);
  assert.equal(a.depositKept, 8000);
  assert.equal(a.costs, 6000);
  assert.equal(a.costsUnpaid, 6000);
  assert.equal(a.netRevenue, 150000 + 10600 + 8000);
  assert.equal(a.margin, 150000 + 10600 + 8000 - 31500 - 6000);
  assert.equal(a.expectedPayout, null);
});

test('cancellata: conta solo l’acconto trattenuto delle dirette', () => {
  const a = stayAccount(bk({ stage: 'cancellata', total_cents: 150000, deposit_cents: 45000, deposit_paid: 1 }), { settings: S });
  assert.equal(a.price, 45000);
  assert.equal(a.nights, 0);
  assert.equal(stayAccount(bk({ stage: 'cancellata', channel: 'airbnb', total_cents: 150000 }), { settings: S }).price, 0);
});

test('spese: contano nell’anno del periodo (condominio 2026 pagato nel 2027)', () => {
  assert.equal(expenseYear({ date: '2027-02-10', period_from: '2026-01-01' }), 2026);
  assert.equal(expenseYear({ date: '2027-02-10', period_from: null }), 2027);
});

test('riepilogo dell’anno: ricavi netti, spese per tipo, cedolare (trattenuta, versata, da versare), utile, canali, tassa e cauzioni', () => {
  const bookings = [
    bk({ channel: 'diretto', total_cents: 150000 }),
    bk({ channel: 'booking', total_cents: 294400, check_in: '2026-08-10', check_out: '2026-08-17', payout_cents: 185001 }),
    bk({ channel: 'airbnb', total_cents: 100000, check_in: '2026-07-01', check_out: '2026-07-05' }),
    bk({ channel: 'diretto', total_cents: 99900, check_in: '2025-08-01', check_out: '2025-08-05' }), // altro anno
    bk({ channel: 'diretto', total_cents: 99900, house_id: 'isola-bella' }), // altra casa
  ];
  const extras = [
    { booking_id: bookings[0].id, kind: 'tassa_soggiorno', amount_cents: 2800, paid: 1 },
    { booking_id: bookings[1].id, kind: 'tassa_soggiorno', amount_cents: 2400, paid: 0 },
    { booking_id: bookings[1].id, kind: 'altro', amount_cents: 6000, paid: 1 },
  ];
  const expenses = [
    { id: 'e1', house_id: 'faro-blu', category: 'acqua_condominio', amount_cents: 89100, date: '2027-01-15', period_from: '2026-06-01' },
    { id: 'e2', house_id: 'faro-blu', category: 'pulizie', amount_cents: 6000, date: '2026-08-08', booking_id: bookings[0].id },
    { id: 'e3', house_id: 'faro-blu', category: 'luce', amount_cents: 7711, date: '2026-05-10' },
    { id: 'e4', house_id: 'isola-bella', category: 'luce', amount_cents: 5000, date: '2026-05-10' },
  ];
  const remittances = [{ house_id: 'faro-blu', kind: 'tassa_soggiorno', year: 2026, amount_cents: 1000, date: '2026-10-01' },
    { house_id: 'faro-blu', kind: 'cedolare', year: 2026, amount_cents: 10000, date: '2027-06-30' }];
  const r = yearReport({ bookings, extras, expenses, remittances }, HOUSE, 2026, '2026-11-21');
  assert.equal(r.stays.length, 3);
  assert.equal(r.totals.price, 544400);
  assert.equal(r.totals.commission, 47575 + 3660);
  assert.equal(r.totals.netRevenue, 544400 - 47575 - 3660 + 6000);
  assert.equal(r.totals.expenses, 89100 + 6000 + 7711);
  assert.deepEqual(r.byCat, { acqua_condominio: 89100, pulizie: 6000, luce: 7711 });
  assert.equal(r.totals.cedolare, 31500 + 61824 + 21000);
  assert.equal(r.totals.cedolareWithheld, 61824);
  assert.equal(r.totals.cedolareToPay, 31500 + 21000 - 10000);
  assert.equal(r.totals.profit, r.totals.netRevenue - r.totals.expenses - r.totals.cedolare);
  // Seconda cifra (informativa): cedolare solo su Airbnb e Booking.
  assert.equal(r.totals.cedolarePortals, 61824 + 21000);
  assert.equal(r.totals.profitPortalsOnly, r.totals.profit + 31500);
  assert.equal(r.channels.booking.nights, 7);
  assert.equal(r.channels.booking.perNight, Math.round((294400 - 47575 + 6000) / 7));
  assert.equal(r.channels.diretto.perNight, Math.round(150000 / 7));
  assert.deepEqual(r.tourist, { collected: 2800, toCollect: 2400, remitted: 1000, toRemit: 1800 });
  const todo = accountingTodo({ bookings, extras, expenses: expenses.map((x) => ({ ...x, paid: x.id === 'e2' ? 0 : 1 })), remittances }, HOUSE, '2026-11-21');
  const kinds = todo.map((x) => x.kind);
  assert.ok(kinds.includes('payout')); // Airbnb di luglio senza pagamento segnato
  assert.ok(kinds.includes('costs')); // pulizie da pagare
  assert.ok(!kinds.includes('cedolare')); // "Cedolare da versare" tolto (Mattia, 24/11)
  assert.ok(kinds.includes('tassa'));
  assert.ok(!kinds.includes('payout_diff')); // 1 centesimo di differenza: va bene
});

test('controlli: regole di contabilità e versamenti', () => {
  assert.equal(checkAccountingSettings(DEFAULT_ACCOUNTING).ok, true);
  assert.equal(checkAccountingSettings({ ...DEFAULT_ACCOUNTING, cedolare_bp: 9000 }).field, 'cedolare_bp');
  assert.equal(checkAccountingSettings({ channels: { airbnb: [{ from: 'ieri', pct_bp: 1 }] } }).field, 'airbnb');
  assert.equal(checkAccountingSettings({ channels: { booking: [{ from: '2026-01-01', pct_bp: 1 }, { from: '2026-01-01', pct_bp: 2 }] } }).ok, false);
  assert.equal(checkAccountingSettings({ ...DEFAULT_ACCOUNTING, goals: { 2027: 1500000 } }).value.goals['2027'], 1500000);
  assert.equal(checkRemittance({ kind: 'tassa_soggiorno', year: 2026, amount_cents: 100, date: '2026-10-01' }).ok, true);
  assert.equal(checkRemittance({ kind: 'iva', year: 2026, amount_cents: 100, date: '2026-10-01' }).field, 'kind');
  assert.equal(checkRemittance({ kind: 'cedolare', year: 2026, amount_cents: 0, date: '2026-10-01' }).field, 'amount_cents');
});

test('server: modo di pagamento, pagamento della piattaforma, versamenti, regole (solo amministratore), extra pagati in contanti', async () => {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', name: 'Mattia', role: 'admin' });
  const collab = await addUser(db, { email: 'collab@example.invalid', name: 'Collab', role: 'collaboratore' });
  const op = () => crypto.randomUUID();
  const mk = async (channel, check_in, check_out) => (await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: {
    house_id: 'faro-blu', channel, guest_name: 'Prova', guests: 2, check_in, check_out, total_cents: 50000,
  } } })).record;
  const d = await mk('diretto', '2026-12-01', '2026-12-05');
  const r1 = await runOp(db, collab, { opId: op(), type: 'booking.money', payload: { id: d.id, changes: { deposit_method: 'bonifico', balance_method: 'contanti' } } });
  assert.equal(r1.record.balance_method, 'contanti');
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.money', payload: { id: d.id, changes: { deposit_method: '__proto__' } } }), OpError);
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.money', payload: { id: d.id, changes: { payout_cents: 100 } } }), /Airbnb e Booking/);
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.money', payload: { id: d.id, changes: { total_cents: 1 } } }), /non modificabile/);
  const a = await mk('airbnb', '2026-12-10', '2026-12-14');
  const r2 = await runOp(db, admin, { opId: op(), type: 'booking.money', payload: { id: a.id, changes: { payout_cents: 48170, payout_at: '2026-12-02' } } });
  assert.equal(r2.record.payout_cents, 48170);
  // Extra pagato in contanti
  const x = (await runOp(db, admin, { opId: op(), type: 'extra.add', payload: { bookingId: d.id, extra: { kind: 'altro', label: 'Garage', amount_cents: 4000, paid: 0 } } })).record;
  const x2 = await runOp(db, admin, { opId: op(), type: 'extra.update', payload: { id: x.id, version: x.version, changes: { paid: 1, paid_method: 'contanti' } } });
  assert.equal(x2.record.paid_method, 'contanti');
  // Versamenti
  const rem = await runOp(db, collab, { opId: op(), type: 'remittance.add', payload: { remittance: { house_id: 'faro-blu', kind: 'tassa_soggiorno', year: 2026, amount_cents: 12300, date: '2026-11-20' } } });
  assert.equal(rem.record.amount_cents, 12300);
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'remittance.add', payload: { remittance: { house_id: 'casa-x', kind: 'cedolare', year: 2026, amount_cents: 1, date: '2026-11-20' } } }), /casa/);
  assert.equal((await readState(db, collab)).remittances.length, 1);
  const del = await runOp(db, admin, { opId: op(), type: 'remittance.delete', payload: { id: rem.record.id } });
  assert.equal(del.record.deleted, 1);
  // Regole: solo l'amministratore
  const h = await db.prepare("SELECT * FROM houses WHERE id = 'faro-blu'").first();
  assert.deepEqual(accountingSettings(h), DEFAULT_ACCOUNTING);
  const goals = { ...DEFAULT_ACCOUNTING, goals: { 2027: 1500000 } };
  await assert.rejects(runOp(db, collab, { opId: op(), type: 'house.update', payload: { id: 'faro-blu', version: h.version, changes: { accounting: goals } } }), OpError);
  const up = await runOp(db, admin, { opId: op(), type: 'house.update', payload: { id: 'faro-blu', version: h.version, changes: { accounting: goals } } });
  assert.equal(accountingSettings(up.record).goals['2027'], 1500000);
  // Nuovo tipo di spesa: danni
  const e = await runOp(db, admin, { opId: op(), type: 'expense.add', payload: { expense: { house_id: 'faro-blu', category: 'danni', amount_cents: 3000, date: '2026-12-05', booking_id: d.id } } });
  assert.equal(e.record.category, 'danni');
});

test('file per il commercialista: quattro fogli, importi in euro, si rilegge con il lettore Excel', async () => {
  const { accountantSheets } = await import('../public/shared/accounting.js');
  const { buildXlsx } = await import('../public/js/xlsx-write.js');
  const { readSpreadsheet } = await import('../public/js/xlsx.js');
  const { EXPENSE_CATEGORIES } = await import('../public/shared/house.js');
  const b1 = bk({ channel: 'booking', total_cents: 294400, guest_name: 'Ospite <con> "virgolette" & co' });
  const b2 = bk({ check_in: '2026-08-10', check_out: '2026-08-15', total_cents: 100000, deposit_cents: 30000, deposit_paid: 1, deposit_method: 'bonifico', balance_method: 'contanti' });
  const data = {
    bookings: [b1, b2],
    extras: [{ id: 'x1', booking_id: b2.id, kind: 'tassa_soggiorno', amount_cents: 3000, paid: 1 }],
    expenses: [{ id: 'e1', house_id: 'faro-blu', category: 'pulizie', amount_cents: 6000, date: '2026-08-15', paid: 0, booking_id: b2.id, notes: 'Rosa' }],
    remittances: [{ id: 'r1', house_id: 'faro-blu', kind: 'cedolare', year: 2026, amount_cents: 10000, date: '2026-11-30', deleted: 0 }],
  };
  const r = yearReport(data, HOUSE, 2026, '2026-12-01');
  const sheets = accountantSheets(r, HOUSE, data, EXPENSE_CATEGORIES);
  assert.deepEqual(sheets.map((s) => s.name), ['Riepilogo', 'Soggiorni', 'Spese', 'Versamenti']);
  const bytes = buildXlsx(sheets);
  const file = { size: bytes.length, name: 'x.xlsx', arrayBuffer: async () => bytes.buffer };
  const read = await readSpreadsheet(file);
  assert.equal(read.length, 4);
  const stays = read[1].rows;
  assert.equal(stays.length, 3);
  assert.equal(stays[1][3], 'Ospite <con> "virgolette" & co');
  assert.equal(Number(stays[1][5]), 2944); // prezzo in euro
  assert.equal(Number(stays[1][6]), 475.75); // commissione Booking 16,16%
  assert.equal(stays[2][17], 'Bonifico');
  assert.equal(stays[2][18], 'Contanti');
  const summary = read[0].rows.map((x) => x.join('|')).join('\n');
  assert.match(summary, /Ricavi netti/);
  assert.match(summary, /Da versare al Comune\|30/);
  assert.equal(read[2].rows[1][6], 'no');
  assert.equal(read[3].rows[1][1], 'Cedolare');
});
