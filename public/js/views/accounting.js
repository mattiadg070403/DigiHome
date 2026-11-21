// Contabilità: ricavi, spese, cedolare e utile di ogni casa, anno per anno.
// La vedono tutti (anche i collaboratori). Le regole (commissioni, cedolare, obiettivo) le cambia l'amministratore.
// Calcoli in public/shared/accounting.js; qui solo la presentazione.

import { h, icon, newId } from '../dom.js';
import { houseVars, chan, tag, field, setFieldError, openDialog, confirmDialog, switchRow, segmented } from '../ui.js';
import { fmtShort, isIsoDate } from '../../shared/dates.js';
import { dateField } from '../pickers.js';
import { fmtEuro, parseEuro, centsToInput } from '../../shared/money.js';
import { EXPENSE_CATEGORIES, expenseLabel } from '../../shared/house.js';
import {
  PAY_METHODS, VAT_BP, accountingSettings, accountingTodo, accountantSheets, checkAccountingSettings, checkRemittance,
  effectiveBp, expenseYear, lowMargin, stayAccount, yearReport,
} from '../../shared/accounting.js';
import { buildXlsx } from '../xlsx-write.js';
import { expenseDialog } from './archive.js';

const CH = { diretto: 'Diretto', airbnb: 'Airbnb', booking: 'Booking' };
const REMIT = { tassa_soggiorno: 'Tassa di soggiorno', cedolare: 'Cedolare' };

/** "15,5%" da centesimi di punto. */
export function fmtPct(bp) {
  return `${(bp / 100).toLocaleString('it-IT', { maximumFractionDigits: 2 })}%`;
}

/** Da "15,5" o "15.5" a centesimi di punto (1550). null se non valido. */
export function parsePct(text) {
  const s = String(text ?? '').trim().replace('%', '').trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

const minus = (c) => (c ? `− ${fmtEuro(c)}` : fmtEuro(0));
const plus = (c) => `+ ${fmtEuro(c)}`;

/** Righe "voce → importo" con eventuale riga di totale in grassetto e spiegazione sotto. */
function lines(rows) {
  return h('dl', { class: 'acc-lines' }, rows.filter(Boolean).map((r) => h('div', { class: ['acc-line', r.strong && 'strong', r.sub && 'sub'] },
    h('dt', null, r.k, r.hint ? h('span', { class: 'acc-hint', text: r.hint }) : null),
    h('dd', { text: r.v }))));
}

function latestHouse(ctx, house) {
  return ctx.store.data.houses.find((x) => x.id === house.id) || house;
}

/* ------------------------------ Pagina ------------------------------ */

export function renderAccounting(ctx) {
  const { store, ui } = ctx;
  const d = store.data;
  const house = d.houses.find((x) => x.id === ui.houseId) || d.houses[0];
  const admin = d.me.role === 'admin';
  const thisYear = Number(ui.today.slice(0, 4));
  const years = [...new Set([
    thisYear,
    ...d.bookings.filter((b) => b.house_id === house.id).map((b) => Number(b.check_in.slice(0, 4))),
    ...d.expenses.filter((x) => x.house_id === house.id && !x.deleted).map(expenseYear).filter(Boolean),
  ])].sort((a, b) => b - a);
  const year = ui.accYear && years.includes(ui.accYear) ? ui.accYear : thisYear;
  const r = yearReport(d, house, year, ui.today);
  const prevHas = years.includes(year - 1);
  const prev = prevHas ? yearReport(d, house, year - 1, ui.today) : null;
  const t = r.totals;

  const yearSel = h('select', { class: 'input acc-year', attrs: { 'aria-label': 'Anno' },
    onChange: (e) => { ui.accYear = Number(e.target.value); ctx.render(); } },
  years.map((y) => h('option', { value: String(y), text: `Anno ${y}`, selected: y === year })));

  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', { text: 'Contabilità' }), h('div', { class: 'sub', text: 'Ricavi, spese e utile della casa, anno per anno' })),
    h('div', { class: 'btn-row' }, ctx.syncChip(),
      h('button', { class: 'btn', type: 'button', onClick: () => exportFile(ctx, house, r) }, icon('download', { size: 16 }), 'File per il commercialista')));

  const switches = h('div', { class: 'btn-row acc-switches' },
    segmented(d.houses.map((x) => ({ value: x.id, label: x.name, swatch: true, vars: houseVars(x) })), house.id, (id) => ctx.setHouse(id), 'Casa'),
    yearSel);

  const was = (k) => (prev ? `${year - 1}: ${fmtEuro(Math.round(prev.totals[k] / 100) * 100)}` : null);
  const tiles = h('div', { class: 'acc-tiles' },
    tile('Ricavi netti', t.netRevenue, was('netRevenue'), null, () => explain(ctx, house, r, 'ricavi')),
    tile('Spese', t.expenses, was('expenses'), null, () => explain(ctx, house, r, 'spese')),
    tile('Cedolare', t.cedolare, t.cedolareToPay ? `da versare ${fmtEuro(t.cedolareToPay)}` : was('cedolare'), null, () => explain(ctx, house, r, 'cedolare')),
    tile('Utile', t.profit, was('profit'), t.profit < 0 ? 'bad' : 'ok', () => explain(ctx, house, r, 'utile')));

  return h('div', { vars: houseVars(house), class: 'acc' }, head, switches,
    tiles,
    goalBox(ctx, house, r, admin),
    todoBox(ctx, house),
    h('div', { class: 'grid-2 section' }, channelsCard(r), expensesCard(house, r)),
    staysSection(ctx, r),
    h('div', { class: 'grid-2 section' }, touristCard(ctx, house, r), depositsCard(r)),
    remittancesSection(ctx, house, r));
}

/** Riquadro con il numero in euro interi (i centesimi sono nella spiegazione). */
function tile(label, cents, sub, tone, onClick) {
  const round = Math.round(cents / 100) * 100;
  return h('button', { class: 'acc-tile', type: 'button', onClick, attrs: { 'aria-label': `${label}: ${fmtEuro(round)}. Tocca per la spiegazione` } },
    h('span', { class: 'acc-tile-label' }, label, icon('info', { size: 15 })),
    h('strong', { class: ['acc-tile-value', tone], text: fmtEuro(round) }),
    sub ? h('span', { class: 'acc-tile-sub', text: sub }) : null);
}

/** Barra dell'obiettivo annuo (utile). */
function goalBox(ctx, house, r, admin) {
  if (!r.goal) {
    return admin ? h('div', { class: 'acc-goal-empty' },
      h('button', { class: 'btn small ghost', type: 'button', onClick: () => goalDialog(ctx, house, r.year) }, icon('plus', { size: 16 }), `Imposta un obiettivo di utile per il ${r.year}`)) : null;
  }
  const share = r.totals.profit > 0 ? r.totals.profit / r.goal : 0;
  const pctDone = Math.round(share * 100);
  const bar = h('div', { class: 'acc-goal-bar', attrs: { role: 'img', 'aria-label': `Obiettivo raggiunto al ${pctDone}%` } },
    h('span', { class: 'acc-goal-fill', vars: { '--w': `${Math.min(100, Math.max(0, share * 100)).toFixed(1)}%` } }));
  return h('div', { class: 'card card-pad acc-goal' },
    h('div', { class: 'section-head' },
      h('div', null, h('strong', { text: `Obiettivo ${r.year}: ${fmtEuro(r.goal)} di utile` }),
        h('div', { class: 'muted small', text: pctDone >= 100 ? `Raggiunto (${pctDone}%)` : `Raggiunto il ${pctDone}% · mancano ${fmtEuro(r.goal - Math.max(0, r.totals.profit))}` })),
      admin ? h('button', { class: 'btn small ghost', type: 'button', text: 'Modifica', onClick: () => goalDialog(ctx, house, r.year) }) : null),
    bar);
}

/** Cose da sistemare (tutti gli anni). */
function todoBox(ctx, house) {
  const { store, ui } = ctx;
  const list = accountingTodo(store.data, house, ui.today);
  if (!list.length) {
    return h('div', { class: 'section' }, h('div', { class: 'banner ok small', attrs: { role: 'status' } },
      icon('check', { size: 16 }), h('span', { text: 'Niente da sistemare: incassi, pagamenti delle piattaforme e versamenti sono in ordine.' })));
  }
  const showAll = ui.accTodoAll;
  const shown = showAll ? list : list.slice(0, 6);
  const rows = shown.map((x) => h('div', { class: 'row alert-row' },
    h('span', { class: ['lvl', x.level] }, icon('alert', { size: 16 })),
    h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: x.amount ? `${x.text}: ${fmtEuro(x.amount)}` : x.text })),
    h('span', { class: 'row-end' }, x.bookingId
      ? h('a', { class: 'btn small', href: `#/p/${x.bookingId}`, text: 'Apri' })
      : h('button', { class: 'btn small', type: 'button', text: 'Segna versamento',
        onClick: () => remittanceDialog(ctx, house, { kind: x.kind === 'cedolare' ? 'cedolare' : 'tassa_soggiorno', year: x.year, amount_cents: x.amount }) }))));
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { text: 'Da sistemare' }), h('span', { class: 'muted small', text: `${list.length}` })),
    h('div', { class: 'card' }, h('div', { class: 'rows' }, rows,
      list.length > shown.length ? h('div', { class: 'row' }, h('button', { class: 'btn small ghost', type: 'button', text: `Mostra tutte (${list.length})`,
        onClick: () => { ui.accTodoAll = true; ctx.render(); } })) : null)));
}

/** Ricavo per notte, diviso per canale (colori fissi: diretto verde, Airbnb magenta, Booking blu). */
function channelsCard(r) {
  const chans = Object.entries(r.channels).filter(([, c]) => c.nights > 0);
  const max = Math.max(1, ...chans.map(([, c]) => c.perNight));
  const body = chans.length ? h('div', { class: 'acc-bars' }, chans.map(([k, c]) => h('div', { class: 'acc-bar-row' },
    h('div', { class: 'acc-bar-head' },
      h('span', { class: 'acc-bar-label' }, h('span', { class: ['acc-key', k] }), CH[k]),
      h('strong', { class: 'amount', text: `${fmtEuro(c.perNight)} a notte` })),
    h('div', { class: 'acc-bar-track' }, h('span', { class: ['acc-bar', k], vars: { '--w': `${((c.perNight / max) * 100).toFixed(1)}%` } })),
    h('div', { class: 'muted tiny', text: `${c.nights} ${c.nights === 1 ? 'notte' : 'notti'} · ${c.stays} ${c.stays === 1 ? 'soggiorno' : 'soggiorni'} · ${fmtEuro(c.net)} in tutto` }))))
    : h('p', { class: 'hint', text: `Nessun soggiorno nel ${r.year}.` });
  return h('section', { class: 'card card-pad stack' },
    h('h2', { text: 'Ricavo per notte' }),
    body,
    h('p', { class: 'hint', text: 'Prezzo meno la commissione del portale, più gli extra; diviso le notti vendute. Senza tassa di soggiorno.' }));
}

/** Spese per tipo, dalla più alta. */
function expensesCard(house, r) {
  const cats = Object.entries(r.byCat).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...cats.map(([, c]) => c));
  return h('section', { class: 'card card-pad stack' },
    h('div', { class: 'section-head acc-card-head' }, h('h2', { text: 'Spese per tipo' }), h('strong', { class: 'amount', text: fmtEuro(r.totals.expenses) })),
    cats.length ? h('div', { class: 'acc-bars' }, cats.map(([k, c]) => h('div', { class: 'acc-bar-row' },
      h('div', { class: 'acc-bar-head' }, h('span', { class: 'acc-bar-label', text: EXPENSE_CATEGORIES[k]?.label || k }), h('strong', { class: 'amount', text: fmtEuro(c) })),
      h('div', { class: 'acc-bar-track' }, h('span', { class: 'acc-bar exp', vars: { '--w': `${((c / max) * 100).toFixed(1)}%` } })))))
      : h('p', { class: 'hint', text: `Nessuna spesa nel ${r.year}.` }),
    h('p', { class: 'hint' }, 'Ogni spesa conta nell’anno a cui si riferisce. Si inseriscono in ',
      h('a', { href: `#/archivio/spese/${house.id}`, text: 'Archivio → Spese' }), ' o dalla scheda del soggiorno.'));
}

/** Elenco dei soggiorni con il margine. */
function staysSection(ctx, r) {
  const rows = r.stays.map(({ b, a }) => {
    const low = lowMargin(a);
    return h('button', { class: 'row row-button acc-stay', type: 'button', onClick: () => stayDialog(ctx, b.id) },
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title', text: b.guest_name }),
        h('span', { class: 'row-sub' }, chan(b.channel), h('span', { text: `${fmtShort(b.check_in)} → ${fmtShort(b.check_out)}${a.nights ? ` · ${a.nights} ${a.nights === 1 ? 'notte' : 'notti'}` : ''}` }),
          a.cancelled ? tag({ text: 'Cancellata: acconto trattenuto', tone: 'neutral' }) : null,
          a.costsUnpaid ? tag({ text: 'Costi da pagare', tone: 'warn' }) : null)),
      h('span', { class: 'acc-stay-end' },
        h('strong', { class: ['amount', low ? 'warn-text' : 'ok-text'], text: fmtEuro(a.margin) }),
        h('span', { class: 'tiny muted', text: low ? 'margine basso' : 'margine' })));
  });
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { text: `Soggiorni ${r.year}` }), h('span', { class: 'muted small', text: `${r.stays.length}` })),
    rows.length ? h('div', { class: 'card' }, h('div', { class: 'rows' }, rows),
      h('p', { class: 'hint acc-foot', text: 'Margine = ricavo netto − cedolare − costi del soggiorno (pulizie, lavanderia, danni). “Basso” se sotto il 40% del prezzo. Tocca un soggiorno per il conto completo.' }))
      : h('div', { class: 'card empty', text: `Nessun soggiorno nel ${r.year}.` }));
}

function touristCard(ctx, house, r) {
  const x = r.tourist;
  return h('section', { class: 'card card-pad stack' },
    h('h2', { text: 'Tassa di soggiorno' }),
    lines([
      { k: 'Incassata', v: fmtEuro(x.collected) },
      x.toCollect ? { k: 'Ancora da incassare', v: fmtEuro(x.toCollect) } : null,
      { k: 'Versata al Comune', v: fmtEuro(x.remitted) },
      { k: 'Da versare al Comune', v: fmtEuro(x.toRemit), strong: true },
    ]),
    h('p', { class: 'hint', text: 'Non entra nei ricavi né nell’utile: si incassa per conto del Comune e si versa a fine stagione.' }),
    h('div', null, h('button', { class: 'btn small', type: 'button', onClick: () => remittanceDialog(ctx, house, { kind: 'tassa_soggiorno', year: r.year, amount_cents: x.toRemit || null }) },
      icon('plus', { size: 16 }), 'Segna versamento')));
}

function depositsCard(r) {
  const x = r.deposits;
  return h('section', { class: 'card card-pad stack' },
    h('h2', { text: 'Cauzioni' }),
    lines([
      { k: 'Ricevute', v: fmtEuro(x.received) },
      { k: 'Restituite', v: fmtEuro(x.returned) },
      { k: 'Trattenute', v: fmtEuro(x.kept), strong: true },
    ]),
    h('p', { class: 'hint', text: 'Solo la parte trattenuta entra nei ricavi; il costo vero del danno va tra le spese (tipo “Danni”).' }));
}

function remittancesSection(ctx, house, r) {
  const remove = async (x) => {
    const ok = await confirmDialog({ title: 'Eliminare questo versamento?', text: `${REMIT[x.kind]} ${x.year} · ${fmtEuro(x.amount_cents)} del ${fmtShort(x.date)}`, okLabel: 'Elimina', danger: true });
    if (!ok) return;
    ctx.act('remittance.delete', { id: x.id }, {
      optimistic: (s) => ({ ...s, remittances: s.remittances.filter((e) => e.id !== x.id) }),
      message: 'Versamento eliminato',
      undo: () => ctx.act('remittance.restore', { id: x.id }),
    }).catch(() => {});
  };
  const list = [...r.remittances].sort((a, b) => (a.date < b.date ? 1 : -1));
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { text: `Versamenti ${r.year}` }),
      h('button', { class: 'btn small', type: 'button', onClick: () => remittanceDialog(ctx, house, { year: r.year }) }, icon('plus', { size: 16 }), 'Segna versamento')),
    list.length ? h('div', { class: 'card' }, h('div', { class: 'rows' }, list.map((x) => h('div', { class: 'row' },
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title', text: `${REMIT[x.kind]} · ${fmtEuro(x.amount_cents)}` }),
        h('span', { class: 'row-sub', text: [`versata il ${fmtShort(x.date)}`, x.notes].filter(Boolean).join(' · ') })),
      h('button', { class: 'btn small ghost', type: 'button', attrs: { 'aria-label': `Elimina il versamento del ${fmtShort(x.date)}` }, onClick: () => remove(x) }, icon('trash', { size: 16 }))))))
      : h('p', { class: 'hint', text: `Nessun versamento segnato per il ${r.year}: tassa di soggiorno al Comune o cedolare delle prenotazioni dirette (e di Airbnb fino al 2026).` }));
}

/* ------------------------------ Spiegazioni ------------------------------ */

function explain(ctx, house, r, which) {
  const t = r.totals;
  const ced = fmtPct(r.settings.cedolare_bp);
  let title;
  let content;
  if (which === 'ricavi') {
    title = `Ricavi netti ${r.year}`;
    content = [
      lines([
        { k: 'Prezzi dei soggiorni', hint: 'Quanto hanno pagato gli ospiti per il soggiorno, su tutti i canali', v: fmtEuro(t.price) },
        { k: 'Commissioni di Airbnb e Booking', hint: 'Percentuale fissa del canale, IVA compresa', v: minus(t.commission) },
        { k: 'Extra chiesti a parte', hint: 'Garage, pulizie chieste a parte, luce in più… senza commissione', v: plus(t.extras) },
        { k: 'Cauzioni trattenute', v: plus(t.depositKept) },
        { k: 'Ricavi netti', v: fmtEuro(t.netRevenue), strong: true },
      ]),
      h('p', { class: 'hint', text: 'La tassa di soggiorno non è compresa: si incassa per il Comune.' }),
    ];
  } else if (which === 'spese') {
    title = `Spese ${r.year}`;
    content = [
      lines([
        ...Object.entries(r.byCat).sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ k: EXPENSE_CATEGORIES[k]?.label || k, v: fmtEuro(c) })),
        { k: 'Totale spese', v: fmtEuro(t.expenses), strong: true },
      ]),
      h('p', { class: 'hint', text: 'Contano nell’anno a cui si riferiscono: le spese condominiali del 2026 arrivate nel 2027 restano nel 2026 (si guarda l’inizio del periodo).' }),
    ];
  } else if (which === 'cedolare') {
    title = `Cedolare ${r.year}`;
    content = [
      lines([
        { k: `Dovuta: ${ced} dei prezzi dei soggiorni`, hint: 'Solo sul prezzo: mai su extra e tassa di soggiorno', v: fmtEuro(t.cedolare), strong: true },
        { k: 'Già trattenuta dalle piattaforme', hint: 'Booking sempre, Airbnb dal 2027', v: minus(t.cedolareWithheld) },
        { k: 'Versata da te', v: minus(t.cedolareRemitted) },
        { k: 'Ancora da versare', v: fmtEuro(t.cedolareToPay), strong: true },
      ]),
      h('p', { class: 'hint', text: 'Calcolo indicativo: da confermare con il commercialista.' }),
    ];
  } else {
    title = `Utile ${r.year}`;
    content = [
      lines([
        { k: 'Ricavi netti', v: fmtEuro(t.netRevenue) },
        { k: 'Spese', v: minus(t.expenses) },
        { k: `Cedolare (${ced})`, v: minus(t.cedolare) },
        { k: 'Utile', v: fmtEuro(t.profit), strong: true },
      ]),
      h('p', { class: 'hint', text: 'Quello che resta davvero: tassa di soggiorno e cauzioni restituite non contano.' }),
    ];
  }
  const dlg = openDialog({ title, content: h('div', { class: 'stack' }, content),
    actions: [h('button', { class: 'btn primary', type: 'button', text: 'Chiudi', onClick: () => dlg.close() })] });
}

/* ------------------------------ Conto del soggiorno ------------------------------ */

/** Righe del conto di un soggiorno (pagina Contabilità e scheda della prenotazione). */
function accountLines(a, b, settings) {
  const portal = b.channel !== 'diretto';
  const rule = a.rule;
  const ced = fmtPct(settings.cedolare_bp);
  return lines([
    { k: portal ? `Prezzo su ${CH[b.channel]}` : 'Prezzo del soggiorno', hint: a.cancelled ? 'Prenotazione cancellata: resta l’acconto trattenuto' : 'Senza tassa di soggiorno e senza extra', v: fmtEuro(a.price) },
    portal ? { k: `Commissione ${CH[b.channel]}`, hint: `${fmtPct(rule.pct_bp)}${rule.vat ? ` + IVA ${fmtPct(VAT_BP)} = ${fmtPct(effectiveBp(rule))}` : ''} del prezzo`, v: minus(a.commission) } : null,
    a.extras ? { k: 'Extra chiesti a parte', hint: 'Senza commissione né cedolare', v: plus(a.extras) } : null,
    a.depositKept ? { k: 'Cauzione trattenuta', v: plus(a.depositKept) } : null,
    { k: 'Ricavo netto', v: fmtEuro(a.netRevenue), strong: true },
    { k: `Cedolare (${ced})`, hint: a.withheld ? `Già trattenuta da ${CH[b.channel]}` : 'Da versare tu', v: minus(a.cedolare) },
    a.costs ? { k: 'Costi del soggiorno', hint: a.costsUnpaid ? `di cui ${fmtEuro(a.costsUnpaid)} ancora da pagare` : 'Pulizie, lavanderia, danni', v: minus(a.costs) } : null,
    { k: 'Margine', v: fmtEuro(a.margin), strong: true },
  ]);
}

function accountOf(ctx, b) {
  const d = ctx.store.data;
  const settings = accountingSettings(d.houses.find((x) => x.id === b.house_id));
  return { a: stayAccount(b, { extras: d.extras, expenses: d.expenses, settings }), settings };
}

function stayDialog(ctx, id) {
  const b = ctx.store.data.bookings.find((x) => x.id === id);
  if (!b) return;
  const { a, settings } = accountOf(ctx, b);
  const dlg = openDialog({
    title: `${b.guest_name} · ${fmtShort(b.check_in)} → ${fmtShort(b.check_out)}`,
    content: h('div', { class: 'stack' }, h('div', { class: 'row-sub' }, chan(b.channel), lowMargin(a) ? tag({ text: 'Margine basso', tone: 'warn' }) : null),
      accountLines(a, b, settings),
      a.expectedPayout !== null ? h('p', { class: 'hint', text: a.payout === null
        ? `Pagamento di ${CH[b.channel]} atteso: ${fmtEuro(a.expectedPayout)} (non ancora segnato come arrivato).`
        : `Pagamento di ${CH[b.channel]} arrivato: ${fmtEuro(a.payout)}${a.payoutDiff && Math.abs(a.payoutDiff) > 100 ? ` · diverso dal calcolato di ${fmtEuro(Math.abs(a.payoutDiff))}` : ''}.` }) : null),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Chiudi', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Apri la scheda', onClick: () => { dlg.close(); ctx.go(`p/${b.id}`); } }),
    ],
  });
}

/** Pannello "Conto del soggiorno" nella scheda della prenotazione. */
export function stayAccountPanel(ctx, b) {
  const d = ctx.store.data;
  const { a, settings } = accountOf(ctx, b);
  if (a.cancelled && !a.price) return null;
  const portal = b.channel !== 'diretto';
  const setMoney = (changes, message) => ctx.act('booking.money', { id: b.id, changes }, {
    optimistic: (s) => ({ ...s, bookings: s.bookings.map((x) => (x.id === b.id ? { ...x, ...changes } : x)) }), message,
  }).catch(() => {});
  const methodSeg = (key, label) => h('div', { class: 'acc-method' },
    h('span', { class: 'small', text: label }),
    segmented(Object.entries(PAY_METHODS).map(([k, l]) => ({ value: k, label: l })), b[key], (v) => setMoney({ [key]: v }, `${label}: ${PAY_METHODS[v].toLowerCase()}`), label));

  const methods = [];
  if (!portal && b.deposit_cents > 0) methods.push(methodSeg('deposit_method', `Acconto ${fmtEuro(b.deposit_cents)}`));
  if (!portal && b.total_cents > (b.deposit_cents || 0)) methods.push(methodSeg('balance_method', `Saldo ${fmtEuro(b.total_cents - (b.deposit_cents || 0))}`));

  let payout = null;
  if (a.expectedPayout !== null) {
    const diff = a.payoutDiff !== null && Math.abs(a.payoutDiff) > 100;
    payout = h('div', { class: ['acc-payout', diff && 'warn'] },
      h('div', { class: 'stack acc-tight' },
        h('strong', { text: `Pagamento di ${CH[b.channel]}` }),
        h('span', { class: 'small', text: `Netto atteso: ${fmtEuro(a.expectedPayout)} (prezzo − commissione${a.withheld ? ' − ritenuta' : ''})` }),
        a.payout !== null
          ? h('span', { class: 'small' }, tag({ text: `Arrivati ${fmtEuro(a.payout)}${b.payout_at ? ` il ${fmtShort(b.payout_at)}` : ''}`, tone: diff ? 'warn' : 'ok' }))
          : h('span', { class: 'small muted', text: 'Non ancora segnato come arrivato.' }),
        diff ? h('span', { class: 'small', text: `Differenza di ${fmtEuro(Math.abs(a.payoutDiff))}: controlla la percentuale della commissione in Impostazioni → Case → Contabilità.` }) : null),
      h('button', { class: 'btn small', type: 'button', text: a.payout === null ? 'Segna pagamento ricevuto' : 'Modifica', onClick: () => payoutDialog(ctx, b, a) }));
  }

  const costs = d.expenses.filter((x) => x.booking_id === b.id && !x.deleted);
  const costRows = costs.map((x) => h('button', { class: 'extra-row row-button acc-cost', type: 'button', onClick: () => expenseDialog(ctx, x) },
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title', text: `${expenseLabel(x)} · ${fmtEuro(x.amount_cents)}` }),
      h('span', { class: 'row-sub' }, tag({ text: x.paid ? 'Pagata' : 'Da pagare', tone: x.paid ? 'ok' : 'warn' }), x.notes ? h('span', { text: x.notes.slice(0, 60) }) : null)),
    icon('chevron', { size: 16 })));

  return h('section', { class: 'card card-pad stack acc-panel' },
    h('div', { class: 'extras-head' }, h('h2', { text: 'Conto del soggiorno' }), lowMargin(a) ? tag({ text: 'Margine basso', tone: 'warn' }) : null),
    accountLines(a, b, settings),
    payout,
    methods.length ? h('div', { class: 'stack acc-tight' }, h('strong', { text: 'Come ha pagato' }), methods) : null,
    h('div', { class: 'stack extras' },
      h('div', { class: 'extras-head' }, h('strong', { text: 'Costi del soggiorno' }),
        h('button', { class: 'btn small', type: 'button', onClick: () => addStayCosts(ctx, b) }, icon('plus', { size: 16 }), 'Aggiungi costi del soggiorno')),
      costRows.length ? costRows : h('p', { class: 'hint', text: 'Pulizie, lavanderia o danni di questo soggiorno. Si possono segnare “da pagare” e pagare dopo; i dettagli vanno nelle note.' })));
}

/** Nuova spesa legata al soggiorno (pulizie, non ancora pagata, data della partenza). */
export function addStayCosts(ctx, b) {
  const date = b.check_out <= ctx.ui.today ? b.check_out : ctx.ui.today;
  expenseDialog(ctx, null, { house_id: b.house_id, booking_id: b.id, category: 'pulizie', paid: 0, date });
}

function payoutDialog(ctx, b, a) {
  const v = { amount: Number.isInteger(b.payout_cents) ? b.payout_cents : a.expectedPayout, date: b.payout_at || ctx.ui.today };
  const amount = h('input', { class: 'input', inputmode: 'decimal', autocomplete: 'off', value: centsToInput(v.amount),
    onInput: (e) => { const c = parseEuro(e.target.value); setFieldError(amount, c === null ? 'Importo non valido' : ''); v.amount = c; check(); } });
  const date = dateField({ value: v.date, label: 'Data (gg/mm/aaaa)', today: ctx.ui.today, onChange: (s) => { v.date = s; } }).el;
  const note = h('p', { class: 'hint' });
  const check = () => {
    const diff = v.amount === null ? 0 : v.amount - a.expectedPayout;
    note.textContent = Math.abs(diff) > 100
      ? `Diverso dal netto atteso (${fmtEuro(a.expectedPayout)}) di ${fmtEuro(Math.abs(diff))}. Se è giusto, salva pure: lo troverai in “Da sistemare” per controllare la percentuale.`
      : `Netto atteso: ${fmtEuro(a.expectedPayout)}.`;
  };
  check();
  const actions = [
    h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
    h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
  ];
  if (Number.isInteger(b.payout_cents)) actions.unshift(h('button', { class: 'btn danger ghost', type: 'button', text: 'Togli', onClick: () => send({ payout_cents: null, payout_at: null }, 'Pagamento tolto') }));
  const dlg = openDialog({
    title: `Pagamento ricevuto da ${CH[b.channel]}`,
    content: h('div', { class: 'stack' },
      h('p', { class: 'muted small', text: `Quanto è arrivato sul conto per ${b.guest_name}.` }),
      h('div', { class: 'form-grid' }, field('Importo arrivato (€)', amount), field('Data', date)), note),
    actions,
  });
  async function send(changes, message) {
    try {
      await ctx.act('booking.money', { id: b.id, changes }, {
        optimistic: (s) => ({ ...s, bookings: s.bookings.map((x) => (x.id === b.id ? { ...x, ...changes } : x)) }), message,
      });
      dlg.close();
    } catch (e) { dlg.setBanner(e.message); }
  }
  function save() {
    if (!v.amount) { setFieldError(amount, 'Scrivi l’importo'); amount.focus(); return; }
    if (!isIsoDate(v.date)) { dlg.setBanner('Scrivi la data in cui è arrivato.'); return; }
    send({ payout_cents: v.amount, payout_at: v.date }, 'Pagamento segnato');
  }
}

/** Come è stato pagato (per gli extra): bonifico, contanti o non specificato. Restituisce il metodo, null o undefined (annullato). */
export function askPayMethod(title = 'Come è stato pagato?') {
  return new Promise((resolve) => {
    let answered = false;
    const pick = (v) => { if (!answered) { answered = true; resolve(v); } dlg.close(); };
    const dlg = openDialog({
      title,
      content: h('div', { class: 'stack' },
        h('div', { class: 'btn-row' }, Object.entries(PAY_METHODS).map(([k, l]) => h('button', { class: 'btn', type: 'button', text: l, onClick: () => pick(k) }))),
        h('button', { class: 'btn ghost small', type: 'button', text: 'Non specificare', onClick: () => pick(null) })),
      onClose: () => { if (!answered) { answered = true; resolve(undefined); } },
    });
  });
}

/* ------------------------------ Versamenti, obiettivo, file ------------------------------ */

function remittanceDialog(ctx, house, preset = {}) {
  const thisYear = Number(ctx.ui.today.slice(0, 4));
  const v = { kind: preset.kind || 'tassa_soggiorno', year: preset.year || thisYear, amount_cents: preset.amount_cents || null, date: ctx.ui.today, notes: '' };
  const kindBox = h('div');
  const drawKind = () => kindBox.replaceChildren(segmented(Object.entries(REMIT).map(([k, l]) => ({ value: k, label: l })), v.kind, (k) => { v.kind = k; drawKind(); }, 'Cosa hai versato'));
  drawKind();
  const years = [];
  for (let y = thisYear + 1; y >= thisYear - 5; y -= 1) years.push(y);
  if (!years.includes(v.year)) years.push(v.year);
  const yearSel = h('select', { class: 'input', onChange: (e) => { v.year = Number(e.target.value); } },
    years.map((y) => h('option', { value: String(y), text: String(y), selected: y === v.year })));
  const amount = h('input', { class: 'input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: v.amount_cents ? centsToInput(v.amount_cents) : '',
    onInput: (e) => { const c = parseEuro(e.target.value); setFieldError(amount, c === null ? 'Importo non valido' : ''); v.amount_cents = c; } });
  const date = dateField({ value: v.date, label: 'Data (gg/mm/aaaa)', today: ctx.ui.today, onChange: (s) => { v.date = s; } }).el;
  const notes = h('input', { class: 'input', maxlength: '300', autocomplete: 'off', placeholder: 'es. F24 del 16/06', onInput: (e) => { v.notes = e.target.value; } });
  const dlg = openDialog({
    title: `Segna versamento · ${house.name}`,
    content: h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('div', { class: 'label', text: 'Cosa hai versato' }), kindBox),
      h('div', { class: 'form-grid' },
        field('Si riferisce all’anno', yearSel), field('Importo (€)', amount),
        field('Data del versamento', date), field('Note (facoltative)', notes))),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
    ],
  });
  async function save() {
    const r = checkRemittance(v);
    if (!r.ok) { if (r.field === 'amount_cents') setFieldError(amount, r.error); dlg.setBanner(r.error); return; }
    const id = newId();
    const rec = { house_id: house.id, ...r.value };
    try {
      await ctx.act('remittance.add', { id, remittance: rec }, {
        optimistic: (s) => ({ ...s, remittances: [...s.remittances, { id, ...rec, deleted: 0, version: 1, rev: -1 }] }),
        message: 'Versamento segnato',
        undo: () => ctx.act('remittance.delete', { id }),
      });
      dlg.close();
    } catch (e) { dlg.setBanner(e.message); }
  }
}

function goalDialog(ctx, house, year) {
  const cur = accountingSettings(latestHouse(ctx, house));
  const amount = h('input', { class: 'input', inputmode: 'decimal', autocomplete: 'off', placeholder: 'es. 30000', value: cur.goals[String(year)] ? centsToInput(cur.goals[String(year)]) : '' });
  const dlg = openDialog({
    title: `Obiettivo di utile ${year} · ${house.name}`,
    content: h('div', { class: 'stack' }, field('Utile che vuoi raggiungere (€)', amount, { hint: 'Vuoto = nessun obiettivo. Lo vedono tutti nella pagina Contabilità.' })),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
    ],
  });
  async function save() {
    const txt = amount.value.trim();
    const c = txt ? parseEuro(txt) : 0;
    if (c === null) { setFieldError(amount, 'Importo non valido'); return; }
    const h0 = latestHouse(ctx, house);
    const s = accountingSettings(h0);
    const goals = { ...s.goals };
    if (c) goals[String(year)] = c; else delete goals[String(year)];
    try {
      await ctx.act('house.update', { id: h0.id, version: h0.version, changes: { accounting: { ...s, goals } } }, { message: c ? 'Obiettivo salvato' : 'Obiettivo tolto' });
      dlg.close();
    } catch (e) { dlg.setBanner(e.message); }
  }
}

function asciiName(s) {
  return String(s).normalize('NFD').split('').filter((ch) => { const c = ch.charCodeAt(0); return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32 || c === 45; }).join('').trim().replace(/ +/g, '-');
}

function exportFile(ctx, house, report) {
  try {
    const bytes = buildXlsx(accountantSheets(report, house, ctx.store.data, EXPENSE_CATEGORIES));
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `Contabilita-${asciiName(house.name)}-${report.year}.xlsx` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    ctx.toast(`File ${report.year} di ${house.name} scaricato`);
  } catch (e) {
    ctx.toast('Non sono riuscito a creare il file.', { bad: true });
    throw e;
  }
}

/* ------------------------------ Impostazioni (amministratore) ------------------------------ */

/** Regole della contabilità di una casa: commissioni dei portali con la data da cui valgono, cedolare. */
export function accountingSettingsDialog(ctx, house) {
  const cur = accountingSettings(house);
  const rules = {
    airbnb: cur.channels.airbnb.map((r) => ({ ...r, pct: fmtPct(r.pct_bp).replace('%', '') })),
    booking: cur.channels.booking.map((r) => ({ ...r, pct: fmtPct(r.pct_bp).replace('%', '') })),
  };
  const ced = h('input', { class: 'input', inputmode: 'decimal', value: fmtPct(cur.cedolare_bp).replace('%', '') });
  const boxes = {};
  const draw = (ch) => {
    boxes[ch].replaceChildren(
      ...rules[ch].map((r, i) => h('div', { class: 'acc-rule' },
        h('div', { class: 'form-grid' },
          field('Dal giorno', dateField({ value: r.from, label: 'Dal (gg/mm/aaaa)', today: ctx.ui.today, onChange: (s) => { r.from = s; } }).el),
          field('Commissione (%)', h('input', { class: 'input', inputmode: 'decimal', value: r.pct, onInput: (e) => { r.pct = e.target.value; } }))),
        switchRow('Più IVA 22% sulla commissione', { checked: r.vat, onChange: (c) => { r.vat = c; } }),
        switchRow(`La cedolare la trattiene ${CH[ch]}`, { checked: r.withheld, onChange: (c) => { r.withheld = c; }, hint: 'Se è spenta, la cedolare la versi tu' }),
        rules[ch].length > 1 ? h('div', null, h('button', { class: 'btn ghost danger small', type: 'button', text: 'Togli questa regola', onClick: () => { rules[ch].splice(i, 1); draw(ch); } })) : null)),
      h('div', null, h('button', { class: 'btn small', type: 'button', onClick: () => { const last = rules[ch][rules[ch].length - 1] || {}; rules[ch].push({ from: ctx.ui.today, pct: last.pct || '', vat: Boolean(last.vat), withheld: Boolean(last.withheld) }); draw(ch); } },
        icon('plus', { size: 16 }), 'Nuova regola da una data')));
  };
  for (const ch of ['airbnb', 'booking']) { boxes[ch] = h('div', { class: 'stack' }); draw(ch); }
  const dlg = openDialog({
    title: `Contabilità · ${house.name}`,
    wide: true,
    content: h('div', { class: 'stack' },
      h('p', { class: 'muted small', text: 'Ogni regola vale per i soggiorni che arrivano da quel giorno in poi, finché non ne inizia un’altra. Le prenotazioni dirette non hanno commissione.' }),
      h('h3', { text: 'Airbnb' }), boxes.airbnb,
      h('h3', { text: 'Booking' }), boxes.booking,
      h('p', { class: 'hint', text: 'Per Booking basta la percentuale complessiva (commissione + costi): per esempio 475,86 € su 2.944 € = 16,16%.' }),
      h('h3', { text: 'Cedolare secca' }),
      field('Percentuale (%)', ced, { hint: 'Solo sul prezzo dei soggiorni, mai su extra e tassa di soggiorno' })),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
    ],
  });
  async function save() {
    dlg.setBanner('');
    const channels = {};
    for (const ch of ['airbnb', 'booking']) {
      channels[ch] = [];
      for (const r of rules[ch]) {
        const p = parsePct(r.pct);
        if (p === null) { dlg.setBanner(`${CH[ch]}: scrivi la percentuale (es. 15,5).`); return; }
        if (!isIsoDate(r.from)) { dlg.setBanner(`${CH[ch]}: scrivi la data da cui vale ogni regola.`); return; }
        channels[ch].push({ from: r.from, pct_bp: p, vat: r.vat, withheld: r.withheld });
      }
    }
    const cb = parsePct(ced.value);
    if (cb === null) { setFieldError(ced, 'Percentuale non valida'); dlg.setBanner('Controlla la cedolare.'); return; }
    const h0 = latestHouse(ctx, house);
    const check = checkAccountingSettings({ channels, cedolare_bp: cb, goals: accountingSettings(h0).goals });
    if (!check.ok) { dlg.setBanner(check.error); return; }
    try {
      await ctx.act('house.update', { id: h0.id, version: h0.version, changes: { accounting: check.value } }, { message: 'Regole della contabilità salvate' });
      dlg.close();
    } catch (e) { dlg.setBanner(e.message); }
  }
}
