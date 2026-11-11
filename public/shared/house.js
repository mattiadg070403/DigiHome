// Archivio della casa: regole comuni ad app e server per spese e scadenze.

import { addDays, daysBetween, fmtShort, isIsoDate } from './dates.js';
import { fmtEuro } from './money.js';

/* ------------------------------- Spese ------------------------------- */

export const EXPENSE_CATEGORIES = {
  acqua_condominio: { label: 'Acqua e condominio', period: true, hint: 'Spese condominiali, acqua compresa' },
  tari: { label: 'TARI', period: true, hint: 'Tassa sui rifiuti: rata o anno' },
  pulizie: { label: 'Pulizie', period: false, hint: 'Pulizie di un soggiorno o della casa' },
  lavanderia: { label: 'Lavanderia', period: false, hint: 'Lenzuola e asciugamani' },
  manutenzione: { label: 'Manutenzione', period: false, hint: 'Riparazioni, idraulico, elettricista…' },
  acquisti: { label: 'Acquisti', period: false, hint: 'Detersivi, carta, piccoli acquisti per la casa' },
  altro: { label: 'Altro', period: false, hint: 'Qualsiasi altra spesa' },
};

export function expenseLabel(x) {
  const cat = EXPENSE_CATEGORIES[x.category]?.label || 'Spesa';
  return x.label ? `${cat} · ${x.label}` : cat;
}

/** Periodo di una spesa: "giu–lug 2027", "2027", oppure null. */
export function expensePeriod(x) {
  if (!x.period_from) return null;
  if (!x.period_to || x.period_to === x.period_from) return fmtShort(x.period_from);
  return `${fmtShort(x.period_from)} → ${fmtShort(x.period_to)}`;
}

/** Controllo dei dati di una spesa. Restituisce { ok, value } oppure { ok: false, error, field }. */
export function validateExpense(input, { partial = false } = {}) {
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const bad = (error, field) => ({ ok: false, error, field });
  if (!partial || has('category')) {
    if (!EXPENSE_CATEGORIES[input.category]) return bad('Scegli il tipo di spesa', 'category');
    v.category = input.category;
  }
  if (!partial || has('label')) {
    const s = String(input.label ?? '').trim();
    if (s.length > 120) return bad('Descrizione troppo lunga', 'label');
    v.label = s || null;
  }
  if (!partial || has('amount_cents')) {
    const n = Number(input.amount_cents);
    if (!Number.isSafeInteger(n) || n < 0 || n > 100000000) return bad('Importo non valido', 'amount_cents');
    v.amount_cents = n;
  }
  if (!partial || has('date')) {
    if (!isIsoDate(input.date)) return bad('Scrivi la data', 'date');
    v.date = input.date;
  }
  for (const k of ['period_from', 'period_to', 'due_date']) {
    if (!partial || has(k)) {
      const s = input[k] || null;
      if (s !== null && !isIsoDate(s)) return bad('Data non valida', k);
      v[k] = s;
    }
  }
  if (!partial || has('paid')) v.paid = input.paid === undefined ? 1 : (input.paid ? 1 : 0);
  if (!partial || has('notes')) {
    const s = String(input.notes ?? '').trim();
    if (s.length > 1000) return bad('Note troppo lunghe', 'notes');
    v.notes = s || null;
  }
  if (has('booking_id')) v.booking_id = input.booking_id || null;
  const from = has('period_from') || !partial ? v.period_from : undefined;
  const to = has('period_to') || !partial ? v.period_to : undefined;
  if (from && to && to < from) return bad('La fine del periodo è prima dell’inizio', 'period_to');
  return { ok: true, value: v };
}

/** Totali per categoria e complessivo di un elenco di spese. */
export function expenseTotals(list) {
  const byCat = {};
  let total = 0;
  for (const x of list) {
    byCat[x.category] = (byCat[x.category] || 0) + x.amount_cents;
    total += x.amount_cents;
  }
  return { total, byCat };
}

/* ------------------------------ Scadenze ------------------------------ */

export const REPEAT = { none: 'Una volta sola', monthly: 'Ogni mese', quarterly: 'Ogni 3 mesi', yearly: 'Ogni anno' };

/** Data successiva di una scadenza ricorrente (stesso giorno del mese, limitato ai giorni del mese). */
export function nextDue(date, repeat) {
  if (repeat === 'none') return null;
  const [y, m, d] = date.split('-').map(Number);
  const months = repeat === 'monthly' ? 1 : repeat === 'quarterly' ? 3 : 12;
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function validateDeadline(input, { partial = false } = {}) {
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const bad = (error, field) => ({ ok: false, error, field });
  if (!partial || has('title')) {
    const s = String(input.title ?? '').trim();
    if (!s || s.length > 160) return bad('Scrivi di cosa si tratta', 'title');
    v.title = s;
  }
  if (!partial || has('due_date')) {
    if (!isIsoDate(input.due_date)) return bad('Scrivi la data di scadenza', 'due_date');
    v.due_date = input.due_date;
  }
  if (!partial || has('repeat')) {
    const r = input.repeat || 'none';
    if (!REPEAT[r]) return bad('Ripetizione non valida', 'repeat');
    v.repeat = r;
  }
  if (!partial || has('notice_days')) {
    const n = input.notice_days === undefined || input.notice_days === '' ? 30 : Number(input.notice_days);
    if (!Number.isInteger(n) || n < 0 || n > 365) return bad('Preavviso non valido (giorni, da 0 a 365)', 'notice_days');
    v.notice_days = n;
  }
  if (!partial || has('notes')) {
    const s = String(input.notes ?? '').trim();
    if (s.length > 1000) return bad('Note troppo lunghe', 'notes');
    v.notes = s || null;
  }
  if (has('house_id')) v.house_id = input.house_id || null;
  return { ok: true, value: v };
}

/**
 * Stato di una scadenza rispetto a oggi: { key, label, tone, days }.
 * key: scaduta | oggi | vicina | lontana | fatta
 */
export function deadlineStatus(x, today) {
  if (x.done) return { key: 'fatta', label: 'Fatta', tone: 'ok', days: 0 };
  const days = daysBetween(today, x.due_date);
  if (days < 0) return { key: 'scaduta', label: `Scaduta da ${-days} ${-days === 1 ? 'giorno' : 'giorni'}`, tone: 'bad', days };
  if (days === 0) return { key: 'oggi', label: 'Scade oggi', tone: 'bad', days };
  if (days <= x.notice_days) return { key: 'vicina', label: days === 1 ? 'Scade domani' : `Scade tra ${days} giorni`, tone: 'warn', days };
  return { key: 'lontana', label: 'In programma', tone: 'neutral', days };
}

/** Avvisi per Oggi: scadenze passate o entro il preavviso. */
export function deadlineAlerts(list, today) {
  const out = [];
  for (const x of list) {
    if (x.done || x.deleted) continue;
    const st = deadlineStatus(x, today);
    if (st.key === 'lontana') continue;
    out.push({
      level: st.key === 'vicina' && st.days > 3 ? 'attenzione' : 'urgente',
      key: 'deadline', deadlineId: x.id, houseId: x.house_id,
      text: `${x.title}: ${st.label.toLowerCase()}`,
    });
  }
  return out;
}

/** Spese non pagate con scadenza passata o vicina (entro 7 giorni). */
export function expenseAlerts(list, today) {
  const out = [];
  for (const x of list) {
    if (x.paid || x.deleted || !x.due_date) continue;
    const days = daysBetween(today, x.due_date);
    if (days > 7) continue;
    out.push({
      level: days < 0 ? 'urgente' : 'attenzione', key: 'expense', expenseId: x.id, houseId: x.house_id,
      text: `${expenseLabel(x)} ${fmtEuro(x.amount_cents)}: ${days < 0 ? `da pagare, scaduta ${fmtShort(x.due_date)}` : days === 0 ? 'da pagare oggi' : `da pagare entro ${fmtShort(x.due_date)}`}`,
    });
  }
  return out;
}

export { addDays };
