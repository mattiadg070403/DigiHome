// Contabilità: conto di ogni soggiorno e riepilogo dell'anno per casa.
// Regole di Mattia (21/11/2026), vedi anche migrations/0014_contabilita.sql:
//  - prezzo del soggiorno = quello pagato dall'ospite, senza tassa di soggiorno e senza extra chiesti a parte;
//  - commissione dei portali: percentuale fissa per canale (+ IVA se indicato), con la data da cui vale;
//  - cedolare (21%) solo sul prezzo del soggiorno; Booking la trattiene sempre, Airbnb dal 2027, nelle dirette la si versa;
//  - extra chiesti a parte: ricavo pieno, senza commissione e senza cedolare;
//  - cauzione trattenuta: ricavo (la spesa vera del danno è tra le spese);
//  - tassa di soggiorno: mai nell'utile (si incassa e si versa al Comune);
//  - le spese contano nell'anno a cui si riferiscono (inizio del periodo, altrimenti data della spesa).
// Calcoli in centesimi, arrotondati al centesimo per ogni soggiorno.

import { daysBetween, isIsoDate, addDays } from './dates.js';
import { enteredAfterStay, parseSteps } from './booking.js';

export const VAT_BP = 2200; // IVA sulle commissioni: 22%

export const DEFAULT_ACCOUNTING = {
  channels: {
    airbnb: [
      { from: '2000-01-01', pct_bp: 300, vat: true, withheld: false },
      { from: '2026-10-13', pct_bp: 1550, vat: true, withheld: false },
      { from: '2027-01-01', pct_bp: 1550, vat: true, withheld: true },
    ],
    booking: [{ from: '2000-01-01', pct_bp: 1616, vat: false, withheld: true }],
  },
  cedolare_bp: 2100,
  goals: {},
};

export const PAY_METHODS = { bonifico: 'Bonifico', contanti: 'Contanti' };

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Regole della contabilità di una casa, sempre valide (se mancano o sono rovinate: quelle di partenza). */
export function accountingSettings(house) {
  let raw = house && house.accounting;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw) return clone(DEFAULT_ACCOUNTING);
  const r = checkAccountingSettings(raw);
  return r.ok ? r.value : clone(DEFAULT_ACCOUNTING);
}

/** Controllo delle regole. Restituisce { ok, value } oppure { ok: false, error, field }. */
export function checkAccountingSettings(input) {
  const bad = (error, field) => ({ ok: false, error, field });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Regole non valide');
  const v = { channels: {}, cedolare_bp: 0, goals: {} };
  for (const ch of ['airbnb', 'booking']) {
    const list = (input.channels && input.channels[ch]) || [];
    if (!Array.isArray(list) || list.length > 20) return bad(`Commissioni di ${ch} non valide`, ch);
    const rules = [];
    for (const r of list) {
      if (!r || !isIsoDate(r.from)) return bad(`Commissioni di ${ch === 'airbnb' ? 'Airbnb' : 'Booking'}: data "dal" non valida`, ch);
      const pct = Number(r.pct_bp);
      if (!Number.isInteger(pct) || pct < 0 || pct > 5000) return bad(`Commissioni di ${ch === 'airbnb' ? 'Airbnb' : 'Booking'}: percentuale da 0 a 50`, ch);
      rules.push({ from: r.from, pct_bp: pct, vat: Boolean(r.vat), withheld: Boolean(r.withheld) });
    }
    rules.sort((a, b) => (a.from < b.from ? -1 : 1));
    if (new Set(rules.map((r) => r.from)).size !== rules.length) return bad('Due regole dello stesso canale con la stessa data', ch);
    v.channels[ch] = rules;
  }
  const ced = Number(input.cedolare_bp ?? DEFAULT_ACCOUNTING.cedolare_bp);
  if (!Number.isInteger(ced) || ced < 0 || ced > 5000) return bad('Cedolare: percentuale da 0 a 50', 'cedolare_bp');
  v.cedolare_bp = ced;
  const goals = input.goals || {};
  if (typeof goals !== 'object' || Array.isArray(goals)) return bad('Obiettivi non validi', 'goals');
  for (const [y, c] of Object.entries(goals)) {
    if (!/^\d{4}$/.test(y)) return bad('Anno dell’obiettivo non valido', 'goals');
    if (c === null || c === '' || c === 0) continue;
    const n = Number(c);
    if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000) return bad('Obiettivo non valido', 'goals');
    v.goals[y] = n;
  }
  return { ok: true, value: v };
}

/** Regola del canale valida in una data (la più recente con "dal" non successivo). Dirette: niente commissione. */
export function channelRule(settings, channel, date) {
  if (channel === 'diretto') return { pct_bp: 0, vat: false, withheld: false };
  const list = (settings.channels && settings.channels[channel]) || [];
  let rule = null;
  for (const r of list) if (r.from <= date) rule = r;
  return rule || { pct_bp: 0, vat: false, withheld: false };
}

/** Percentuale effettiva della commissione (IVA compresa), in centesimi di punto: 15,5% + IVA → 1891. */
export function effectiveBp(rule) {
  return rule.vat ? Math.round((rule.pct_bp * (10000 + VAT_BP)) / 10000) : rule.pct_bp;
}

const pct = (cents, bp) => Math.round((cents * bp) / 10000);

/** Anno a cui si riferisce una spesa: inizio del periodo, altrimenti la data. */
export function expenseYear(x) {
  return Number((x.period_from || x.date || '').slice(0, 4)) || null;
}

/**
 * Conto di un soggiorno.
 * Restituisce: prezzo, commissione, cedolare (e quanta trattenuta dalla piattaforma), netto atteso dal portale,
 * extra, cauzione trattenuta, tassa di soggiorno (a parte), costi del soggiorno, ricavo netto e margine.
 */
export function stayAccount(b, { extras = [], expenses = [], settings }) {
  const rule = channelRule(settings, b.channel, b.check_in);
  const cancelled = b.stage === 'cancellata';
  // Cancellata: conta solo l'acconto trattenuto delle dirette (non rimborsabile).
  const price = cancelled ? (b.channel === 'diretto' && b.deposit_paid ? b.deposit_cents : 0) : (b.total_cents || 0);
  const commission = cancelled ? 0 : pct(price, effectiveBp(rule));
  const cedolare = pct(price, settings.cedolare_bp);
  const withheld = rule.withheld && !cancelled ? cedolare : 0;
  const mine = extras.filter((x) => x.booking_id === b.id && !x.deleted);
  const revExtras = mine.filter((x) => x.kind !== 'tassa_soggiorno');
  const taxExtras = mine.filter((x) => x.kind === 'tassa_soggiorno');
  const extrasTotal = revExtras.reduce((s, x) => s + x.amount_cents, 0);
  const extrasUnpaid = revExtras.filter((x) => !x.paid).reduce((s, x) => s + x.amount_cents, 0);
  const depositKept = b.security_status === 'trattenuta' ? b.security_withheld_cents || 0 : 0;
  const costs = expenses.filter((x) => x.booking_id === b.id && !x.deleted);
  const costsTotal = costs.reduce((s, x) => s + x.amount_cents, 0);
  const portal = b.channel !== 'diretto';
  const expectedPayout = portal && !cancelled ? price - commission - withheld : null;
  const payoutDiff = expectedPayout !== null && Number.isInteger(b.payout_cents) ? b.payout_cents - expectedPayout : null;
  const netRevenue = price - commission + extrasTotal + depositKept;
  const n = Math.max(0, daysBetween(b.check_in, b.check_out));
  return {
    id: b.id, channel: b.channel, cancelled, nights: cancelled ? 0 : n, rule,
    price, commission, cedolare, withheld, cedolareToPay: cedolare - withheld,
    expectedPayout, payout: Number.isInteger(b.payout_cents) ? b.payout_cents : null, payoutDiff,
    extras: extrasTotal, extrasUnpaid, depositKept,
    tax: taxExtras.reduce((s, x) => s + x.amount_cents, 0),
    taxPaid: taxExtras.filter((x) => x.paid).reduce((s, x) => s + x.amount_cents, 0),
    costs: costsTotal, costsUnpaid: costs.filter((x) => !x.paid).reduce((s, x) => s + x.amount_cents, 0),
    netRevenue,
    margin: netRevenue - cedolare - costsTotal,
  };
}

/** Margine "basso": sotto il 40% del prezzo (o in perdita). */
export function lowMargin(a) {
  return a.price > 0 && a.margin < a.price * 0.4;
}

/**
 * Riepilogo dell'anno per una casa.
 * data: { bookings, extras, expenses, remittances }; today: data di oggi (per "da sistemare").
 */
export function yearReport(data, house, year, today) {
  const settings = accountingSettings(house);
  const y = String(year);
  const bookings = data.bookings.filter((b) => b.house_id === house.id && b.check_in.slice(0, 4) === y);
  const stays = bookings
    .map((b) => ({ b, a: stayAccount(b, { extras: data.extras, expenses: data.expenses, settings }) }))
    .filter(({ a }) => !a.cancelled || a.price > 0)
    .sort((p, q) => (p.b.check_in < q.b.check_in ? -1 : 1));
  const sum = (f) => stays.reduce((s, x) => s + f(x.a), 0);

  const expenses = (data.expenses || []).filter((x) => x.house_id === house.id && !x.deleted && expenseYear(x) === year);
  const byCat = {};
  for (const x of expenses) byCat[x.category] = (byCat[x.category] || 0) + x.amount_cents;
  const expensesTotal = expenses.reduce((s, x) => s + x.amount_cents, 0);

  const remit = (data.remittances || []).filter((r) => r.house_id === house.id && !r.deleted && r.year === year);
  const remitted = (kind) => remit.filter((r) => r.kind === kind).reduce((s, r) => s + r.amount_cents, 0);

  const totals = {
    price: sum((a) => a.price),
    commission: sum((a) => a.commission),
    extras: sum((a) => a.extras),
    depositKept: sum((a) => a.depositKept),
    netRevenue: sum((a) => a.netRevenue),
    expenses: expensesTotal,
    cedolare: sum((a) => a.cedolare),
    cedolareWithheld: sum((a) => a.withheld),
    cedolareRemitted: remitted('cedolare'),
  };
  totals.cedolareToPay = Math.max(0, totals.cedolare - totals.cedolareWithheld - totals.cedolareRemitted);
  totals.profit = totals.netRevenue - totals.expenses - totals.cedolare;

  // Per canale: notti vendute e ricavo netto per notte (prezzo − commissione + extra).
  const channels = {};
  for (const ch of ['diretto', 'airbnb', 'booking']) {
    const list = stays.filter((x) => x.a.channel === ch && !x.a.cancelled);
    const nights = list.reduce((s, x) => s + x.a.nights, 0);
    const net = list.reduce((s, x) => s + x.a.price - x.a.commission + x.a.extras, 0);
    channels[ch] = { stays: list.length, nights, net, perNight: nights ? Math.round(net / nights) : null };
  }

  // Tassa di soggiorno (a parte) e cauzioni (non entrano nell'utile).
  const tourist = { collected: sum((a) => a.taxPaid), toCollect: sum((a) => a.tax - a.taxPaid), remitted: remitted('tassa_soggiorno') };
  tourist.toRemit = Math.max(0, tourist.collected - tourist.remitted);
  const deposits = { received: 0, returned: 0, kept: 0 };
  for (const { b } of stays) {
    if (['incassata', 'restituita', 'trattenuta'].includes(b.security_status)) deposits.received += b.security_cents;
    if (b.security_status === 'restituita') deposits.returned += b.security_cents;
    if (b.security_status === 'trattenuta') {
      deposits.kept += b.security_withheld_cents || 0;
      deposits.returned += Math.max(0, b.security_cents - (b.security_withheld_cents || 0));
    }
  }

  return { year, settings, stays, expenses, byCat, totals, channels, tourist, deposits, goal: settings.goals[y] || null, remittances: remit };
}

/**
 * Cose da sistemare per una casa (tutti gli anni): soldi da incassare, pagamenti dei portali non arrivati,
 * costi dei soggiorni da pagare, cedolare e tassa di soggiorno da versare.
 * Restituisce [{ level: 'urgente' | 'attenzione', text, bookingId?, kind }].
 */
export function accountingTodo(data, house, today, { years } = {}) {
  const settings = accountingSettings(house);
  const out = [];
  const name = (b) => b.guest_name;
  for (const b of data.bookings) {
    if (b.house_id !== house.id || b.stage === 'cancellata') continue;
    const a = stayAccount(b, { extras: data.extras, expenses: data.expenses, settings });
    // Storico (inserito a soggiorno finito): i soldi sono già stati sistemati allora, non si chiede di segnarli.
    if (enteredAfterStay(b)) continue;
    const arrived = b.check_in <= today;
    if (b.channel === 'diretto' && arrived && b.total_cents > 0 && !parseSteps(b.checkin_steps).pagamenti && b.stage !== 'confermata') {
      out.push({ level: 'attenzione', kind: 'saldo', bookingId: b.id, text: `${name(b)}: saldo non segnato come incassato` });
    }
    if (a.extrasUnpaid > 0 && b.check_out <= today) {
      out.push({ level: 'attenzione', kind: 'extra', bookingId: b.id, text: `${name(b)}: extra da incassare` });
    }
    if (a.expectedPayout !== null && a.payout === null && addDays(b.check_in, 3) <= today && b.total_cents > 0) {
      out.push({ level: 'attenzione', kind: 'payout', bookingId: b.id, text: `${name(b)}: pagamento di ${b.channel === 'airbnb' ? 'Airbnb' : 'Booking'} non ancora segnato come arrivato` });
    }
    if (a.payoutDiff !== null && Math.abs(a.payoutDiff) > 100) {
      out.push({ level: 'attenzione', kind: 'payout_diff', bookingId: b.id, text: `${name(b)}: il pagamento arrivato è diverso dal calcolato (controlla la percentuale della commissione)` });
    }
    if (a.costsUnpaid > 0) {
      out.push({ level: 'attenzione', kind: 'costs', bookingId: b.id, text: `${name(b)}: pulizie o lavanderia da pagare` });
    }
  }
  const yearsList = years || [...new Set(data.bookings.filter((b) => b.house_id === house.id).map((b) => Number(b.check_in.slice(0, 4))))];
  // Cedolare e tassa da versare: solo per gli anni con soggiorni gestiti nell'app (non per gli anni solo di storico).
  const live = new Set(data.bookings.filter((b) => b.house_id === house.id && b.stage !== 'cancellata' && !enteredAfterStay(b))
    .map((b) => Number(b.check_in.slice(0, 4))));
  for (const y of yearsList.sort()) {
    if (y > Number(today.slice(0, 4)) || !live.has(y)) continue;
    const r = yearReport(data, house, y, today);
    if (r.totals.cedolareToPay > 0) out.push({ level: 'attenzione', kind: 'cedolare', year: y, amount: r.totals.cedolareToPay, text: `Cedolare ${y} da versare` });
    if (r.tourist.toRemit > 0) out.push({ level: 'attenzione', kind: 'tassa', year: y, amount: r.tourist.toRemit, text: `Tassa di soggiorno ${y} da versare al Comune` });
  }
  return out;
}

/** Controllo di un versamento (tassa di soggiorno o cedolare). */
export function checkRemittance(input) {
  const bad = (error, field) => ({ ok: false, error, field });
  if (!['tassa_soggiorno', 'cedolare'].includes(input.kind)) return bad('Scegli cosa hai versato', 'kind');
  const year = Number(input.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return bad('Anno non valido', 'year');
  const amount = Number(input.amount_cents);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000) return bad('Importo non valido', 'amount_cents');
  if (!isIsoDate(input.date)) return bad('Scrivi la data del versamento', 'date');
  const notes = String(input.notes ?? '').trim();
  if (notes.length > 300) return bad('Note troppo lunghe', 'notes');
  return { ok: true, value: { kind: input.kind, year, amount_cents: amount, date: input.date, notes: notes || null } };
}

/* ------------------------------ File per il commercialista ------------------------------ */

const CH_LABEL = { diretto: 'Diretto', airbnb: 'Airbnb', booking: 'Booking' };
const itDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

/**
 * Fogli del file Excel per il commercialista (una casa, un anno).
 * categories: nomi dei tipi di spesa ({ chiave: { label } }).
 */
export function accountantSheets(report, house, data, categories = {}) {
  const t = report.totals;
  const eur = (c) => ({ euro: c });
  const B = (v) => ({ v, bold: true });
  const BE = (c) => ({ euro: c, bold: true });
  const summary = [
    [B(`${house.name} · contabilità ${report.year}`)],
    ['Creato con DigiHome. Importi in euro.'],
    [],
    [B('Ricavi'), null],
    ['Prezzi dei soggiorni (senza tassa di soggiorno né extra)', eur(t.price)],
    ['Commissioni delle piattaforme (IVA compresa)', eur(-t.commission)],
    ['Extra chiesti a parte (senza commissione né cedolare)', eur(t.extras)],
    ['Cauzioni trattenute', eur(t.depositKept)],
    [B('Ricavi netti'), BE(t.netRevenue)],
    [],
    [B('Spese'), BE(t.expenses)],
    ...Object.entries(report.byCat).sort((a, b) => b[1] - a[1]).map(([k, c]) => [`  ${categories[k]?.label || k}`, eur(c)]),
    [],
    [B('Cedolare secca'), null],
    [`Dovuta (${report.settings.cedolare_bp / 100}% dei prezzi dei soggiorni)`, eur(t.cedolare)],
    ['Già trattenuta dalle piattaforme (ritenuta)', eur(t.cedolareWithheld)],
    ['Versata', eur(t.cedolareRemitted)],
    [B('Da versare'), BE(t.cedolareToPay)],
    [],
    [B('Utile (ricavi netti − spese − cedolare)'), BE(t.profit)],
    [],
    [B('Tassa di soggiorno (non entra nei ricavi)'), null],
    ['Incassata', eur(report.tourist.collected)],
    ['Ancora da incassare', eur(report.tourist.toCollect)],
    ['Versata al Comune', eur(report.tourist.remitted)],
    [B('Da versare al Comune'), BE(report.tourist.toRemit)],
  ];
  const stays = [[
    'Arrivo', 'Partenza', 'Notti', 'Ospite', 'Canale', 'Prezzo', 'Commissione', 'Extra', 'Cauzione trattenuta', 'Cedolare dovuta',
    'Ritenuta della piattaforma', 'Cedolare da versare', 'Netto atteso dalla piattaforma', 'Netto arrivato', 'Tassa di soggiorno',
    'Costi del soggiorno', 'Margine', 'Acconto', 'Saldo', 'Note',
  ].map(B)];
  for (const { b, a } of report.stays) {
    stays.push([
      itDate(b.check_in), itDate(b.check_out), a.nights, b.guest_name, CH_LABEL[b.channel] || b.channel,
      eur(a.price), eur(a.commission), eur(a.extras), eur(a.depositKept), eur(a.cedolare), eur(a.withheld), eur(a.cedolareToPay),
      a.expectedPayout === null ? null : eur(a.expectedPayout), a.payout === null ? null : eur(a.payout), eur(a.tax),
      eur(a.costs), eur(a.margin),
      b.deposit_method ? PAY_METHODS[b.deposit_method] : '', b.balance_method ? PAY_METHODS[b.balance_method] : '',
      a.cancelled ? 'Cancellata: acconto trattenuto' : '',
    ]);
  }
  const bookingName = Object.fromEntries((data.bookings || []).map((b) => [b.id, `${b.guest_name} (${itDate(b.check_in)})`]));
  const expenses = [['Data', 'Anno', 'Tipo', 'Descrizione', 'Periodo', 'Importo', 'Pagata', 'Soggiorno', 'Note'].map(B)];
  for (const x of [...report.expenses].sort((p, q) => (p.date < q.date ? -1 : 1))) {
    expenses.push([
      itDate(x.date), expenseYear(x), categories[x.category]?.label || x.category, x.label || '',
      x.period_from ? `${itDate(x.period_from)}${x.period_to ? ` – ${itDate(x.period_to)}` : ''}` : '',
      eur(x.amount_cents), x.paid ? 'sì' : 'no', x.booking_id ? bookingName[x.booking_id] || '' : '', x.notes || '',
    ]);
  }
  const remit = [['Data', 'Cosa', 'Anno', 'Importo', 'Note'].map(B)];
  for (const r of report.remittances) {
    remit.push([itDate(r.date), r.kind === 'cedolare' ? 'Cedolare' : 'Tassa di soggiorno', r.year, eur(r.amount_cents), r.notes || '']);
  }
  return [
    { name: 'Riepilogo', rows: summary, widths: [58, 16] },
    { name: 'Soggiorni', rows: stays, widths: [11, 11, 6, 24, 10, 12, 12, 10, 12, 12, 13, 13, 14, 13, 12, 13, 12, 11, 11, 26] },
    { name: 'Spese', rows: expenses, widths: [11, 7, 18, 30, 24, 12, 8, 28, 30] },
    { name: 'Versamenti', rows: remit, widths: [11, 20, 7, 12, 30] },
  ];
}
