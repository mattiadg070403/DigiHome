// Archivio della casa: spese (acqua e condominio, TARI, pulizie, lavanderia, manutenzione, acquisti)
// e scadenze (rinnovi, versamenti, controlli). Lo vedono e lo usano tutti, anche i collaboratori.

import { h, icon, newId } from '../dom.js';
import { houseVars, tag, field, setFieldError, openDialog, confirmDialog, switchRow, segmented } from '../ui.js';
import { addDays, fmtShort, monthName, isIsoDate } from '../../shared/dates.js';
import { fmtEuro, parseEuro, centsToInput } from '../../shared/money.js';
import {
  EXPENSE_CATEGORIES, REPEAT, expenseLabel, expensePeriod, expenseTotals, deadlineStatus, nextDue,
} from '../../shared/house.js';

function readPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* nessun problema */ }
}

export function renderArchive(ctx) {
  const { store, ui } = ctx;
  const d = store.data;
  // Arrivando da un avviso di Oggi (#/archivio/scadenze/faro-blu) si apre la sezione e la casa giuste.
  // Solo la prima volta per ogni indirizzo: dopo, valgono le scelte fatte con i pulsanti.
  const p = ui.route.params || {};
  if (ui.archiveHash !== location.hash) {
    ui.archiveHash = location.hash;
    if (p.tab === 'spese' || p.tab === 'scadenze') ui.archiveTab = p.tab;
    if (p.house && d.houses.some((x) => x.id === p.house) && ui.houseId !== p.house) ctx.setHouse(p.house, { silent: true });
  }
  const house = d.houses.find((x) => x.id === ui.houseId) || d.houses[0];
  if (!ui.archiveTab) ui.archiveTab = readPref('dh.archivio', 'spese');

  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', { text: 'Archivio della casa' }), h('div', { class: 'sub', text: 'Spese e scadenze' })),
    h('div', { class: 'btn-row' },
      ctx.syncChip(),
      ui.archiveTab === 'spese'
        ? h('button', { class: 'btn primary', type: 'button', onClick: () => expenseDialog(ctx, null) }, icon('plus'), 'Nuova spesa')
        : h('button', { class: 'btn primary', type: 'button', onClick: () => deadlineDialog(ctx, null) }, icon('plus'), 'Nuova scadenza')));

  const switches = h('div', { class: 'btn-row' },
    segmented(d.houses.map((x) => ({ value: x.id, label: x.name, swatch: true, vars: houseVars(x) })), house.id, (id) => ctx.setHouse(id), 'Casa'),
    segmented([{ value: 'spese', label: 'Spese' }, { value: 'scadenze', label: 'Scadenze' }], ui.archiveTab, (v) => {
      ui.archiveTab = v;
      writePref('dh.archivio', v);
      ctx.render();
    }, 'Sezione'));
  switches.style.marginBottom = '20px';

  return h('div', { vars: houseVars(house) }, head, switches,
    ui.archiveTab === 'spese' ? expensesView(ctx, house) : deadlinesView(ctx, house));
}

/* --------------------------------- Spese --------------------------------- */

function expensesView(ctx, house) {
  const { store, ui } = ctx;
  const mine = store.data.expenses.filter((x) => x.house_id === house.id);
  const thisYear = Number(ui.today.slice(0, 4));
  const years = [...new Set([thisYear, ...mine.map((x) => Number(x.date.slice(0, 4)))])].sort((a, b) => b - a);
  const year = ui.expenseYear && years.includes(ui.expenseYear) ? ui.expenseYear : thisYear;
  const list = mine.filter((x) => Number(x.date.slice(0, 4)) === year).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const unpaid = mine.filter((x) => !x.paid).sort((a, b) => ((a.due_date || a.date) < (b.due_date || b.date) ? -1 : 1));
  const totals = expenseTotals(list);

  const yearSel = h('select', { class: 'input', attrs: { 'aria-label': 'Anno' },
    onChange: (e) => { ui.expenseYear = Number(e.target.value); ctx.render(); } },
  years.map((y) => h('option', { value: String(y), text: `Anno ${y}`, selected: y === year })));
  yearSel.style.width = 'auto';

  const summary = h('div', { class: 'card' },
    h('div', { class: 'stack' },
      h('div', { class: 'section-head' }, h('h2', { text: `Totale ${year}: ${fmtEuro(totals.total)}` }), yearSel),
      Object.keys(totals.byCat).length
        ? h('dl', { class: 'kv' }, Object.entries(EXPENSE_CATEGORIES).filter(([k]) => totals.byCat[k]).flatMap(([k, c]) => [
          h('dt', { text: c.label }), h('dd', { text: fmtEuro(totals.byCat[k]) })]))
        : h('p', { class: 'hint', text: 'Nessuna spesa in questo anno.' })));

  // Raggruppate per mese, dalla più recente.
  const months = new Map();
  for (const x of list) {
    const k = x.date.slice(0, 7);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(x);
  }
  const groups = [...months.entries()].map(([ym, items]) => {
    const [, m] = ym.split('-').map(Number);
    const name = monthName(m);
    return h('section', { class: 'section' },
      h('div', { class: 'section-head' },
        h('h3', { text: `${name.charAt(0).toUpperCase()}${name.slice(1)}` }),
        h('span', { class: 'muted small', text: fmtEuro(expenseTotals(items).total) })),
      h('div', { class: 'card' }, h('div', { class: 'rows' }, items.map((x) => expenseRow(ctx, x)))));
  });

  return h('div', { class: 'stack' },
    unpaid.length ? h('section', { class: 'section', attrs: { 'aria-label': 'Da pagare' } },
      h('div', { class: 'section-head' }, h('h2', { text: 'Da pagare' })),
      h('div', { class: 'card' }, h('div', { class: 'rows' }, unpaid.map((x) => expenseRow(ctx, x, true))))) : null,
    summary,
    groups.length ? groups : h('div', { class: 'empty card', text: 'Ancora nessuna spesa. Premi "Nuova spesa" per inserire la prima.' }));
}

function expenseRow(ctx, x, showPay = false) {
  const { ui } = ctx;
  const period = expensePeriod(x);
  const sub = [fmtShort(x.date), period ? `periodo ${period}` : null, x.notes ? x.notes.slice(0, 60) : null].filter(Boolean).join(' · ');
  let status = null;
  if (!x.paid) {
    const late = x.due_date && x.due_date < ui.today;
    status = tag({ text: x.due_date ? `${late ? 'Scaduta' : 'Da pagare entro'} ${fmtShort(x.due_date)}` : 'Da pagare', tone: late ? 'bad' : 'warn' });
  }
  const markPaid = () => {
    ctx.act('expense.update', { id: x.id, version: x.version, changes: { paid: 1 } }, {
      optimistic: (d) => ({ ...d, expenses: d.expenses.map((e) => (e.id === x.id ? { ...e, paid: 1 } : e)) }),
      message: 'Segnata come pagata',
      undo: (r) => ctx.act('expense.update', { id: x.id, version: r.record.version, changes: { paid: 0 } }),
    }).catch(() => {});
  };
  return h('div', { class: 'row expense-row' },
    h('button', { class: 'row-main row-button', type: 'button', onClick: () => expenseDialog(ctx, x), attrs: { 'aria-label': `Apri: ${expenseLabel(x)}` } },
      h('span', { class: 'row-title', text: expenseLabel(x) }),
      h('span', { class: 'row-sub' }, status, h('span', { text: sub }))),
    h('span', { class: 'row-end btn-row' },
      h('strong', { class: 'amount', text: fmtEuro(x.amount_cents) }),
      showPay && !x.paid ? h('button', { class: 'btn small', type: 'button', onClick: markPaid }, icon('check', { size: 16 }), 'Pagata') : null));
}

function dateInput(value, label, onChange) {
  return h('input', { class: 'input', type: 'date', value: value || '', attrs: { 'aria-label': label }, onChange: (e) => onChange(e.target.value) });
}

/** Nuova spesa o modifica. Solo dati: importo, data, periodo, note. */
function expenseDialog(ctx, existing) {
  const { store, ui } = ctx;
  const d = store.data;
  const v = existing ? { ...existing } : {
    house_id: ui.houseId, category: 'acquisti', label: '', amount_cents: 0, date: ui.today,
    period_from: null, period_to: null, due_date: null, paid: 1, notes: '', booking_id: null,
  };
  let dirty = false;
  const touch = () => { dirty = true; };

  const houseSel = h('select', { class: 'input', onChange: (e) => { v.house_id = e.target.value; v.booking_id = null; touch(); drawBookings(); } },
    d.houses.map((x) => h('option', { value: x.id, text: x.name, selected: x.id === v.house_id })));
  const catSel = h('select', { class: 'input', onChange: (e) => { v.category = e.target.value; touch(); sync(); } },
    Object.entries(EXPENSE_CATEGORIES).map(([k, c]) => h('option', { value: k, text: c.label, selected: k === v.category })));
  const catHint = h('div', { class: 'hint' });
  const label = h('input', { class: 'input', maxlength: '120', value: v.label || '', autocomplete: 'off',
    onInput: (e) => { v.label = e.target.value; touch(); } });
  const amount = h('input', { class: 'input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: centsToInput(v.amount_cents),
    onInput: (e) => { const c = parseEuro(e.target.value); setFieldError(amount, c === null ? 'Importo non valido' : ''); if (c !== null) v.amount_cents = c; touch(); } });
  const date = dateInput(v.date, 'Data', (s) => { v.date = s; setFieldError(date, ''); touch(); });
  const from = dateInput(v.period_from, 'Periodo dal', (s) => { v.period_from = s || null; touch(); });
  const to = dateInput(v.period_to, 'Periodo al', (s) => { v.period_to = s || null; setFieldError(to, ''); touch(); });
  const periodBox = h('div', { class: 'form-grid' }, field('Periodo dal (facoltativo)', from), field('al', to));
  const due = dateInput(v.due_date, 'Da pagare entro', (s) => { v.due_date = s || null; touch(); });
  const dueBox = field('Da pagare entro (facoltativo)', due, { hint: 'Ti avviso in Oggi una settimana prima' });
  const notes = h('textarea', { class: 'input', rows: '2', maxlength: '1000', value: v.notes || '',
    onInput: (e) => { v.notes = e.target.value; touch(); } });
  notes.value = v.notes || '';
  const bookingBox = h('div');
  function drawBookings() {
    // Spesa legata a un soggiorno (pulizie, lavanderia): soggiorni della casa dagli ultimi 60 giorni ai prossimi 30.
    const near = d.bookings.filter((b) => b.house_id === v.house_id && b.stage !== 'cancellata'
      && (b.id === v.booking_id || (b.check_out >= addDays(ui.today, -60) && b.check_in <= addDays(ui.today, 30))))
      .sort((a, b) => (a.check_in < b.check_in ? 1 : -1));
    const sel = h('select', { class: 'input', onChange: (e) => { v.booking_id = e.target.value || null; touch(); } },
      h('option', { value: '', text: 'Nessun soggiorno in particolare' }),
      near.map((b) => h('option', { value: b.id, text: `${b.guest_name} · ${fmtShort(b.check_in)} → ${fmtShort(b.check_out)}`, selected: b.id === v.booking_id })));
    bookingBox.replaceChildren(field('Soggiorno (facoltativo)', sel, { hint: 'Per sapere quanto costa ogni soggiorno' }));
  }
  const paidSwitch = switchRow('Già pagata', { checked: Boolean(v.paid), onChange: (c) => { v.paid = c ? 1 : 0; touch(); sync(); } });
  function sync() {
    const c = EXPENSE_CATEGORIES[v.category];
    catHint.textContent = c.hint;
    periodBox.hidden = !c.period;
    bookingBox.hidden = !['pulizie', 'lavanderia'].includes(v.category);
    dueBox.hidden = Boolean(v.paid);
    label.placeholder = v.category === 'altro' ? 'Di cosa si tratta' : 'Facoltativa, es. "2a rata" o "detersivi"';
  }
  drawBookings();
  sync();

  const actions = [
    h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.requestClose() }),
    h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
  ];
  if (existing) actions.unshift(h('button', { class: 'btn danger ghost', type: 'button', text: 'Elimina', onClick: remove }));
  const dlg = openDialog({
    title: existing ? 'Modifica spesa' : 'Nuova spesa',
    canClose: () => !dirty || confirmDialog({ title: 'Uscire senza salvare?', text: 'La spesa non verrà salvata.', okLabel: 'Esci senza salvare' }),
    content: h('div', { class: 'form-grid' },
      field('Casa', houseSel), h('div', { class: 'field' }, field('Tipo di spesa', catSel), catHint),
      field('Importo (€)', amount), field('Data', date),
      h('div', { class: 'full' }, field('Descrizione', label)),
      h('div', { class: 'full' }, periodBox),
      h('div', { class: 'full' }, bookingBox),
      h('div', { class: 'full' }, paidSwitch),
      h('div', { class: 'full' }, dueBox),
      h('div', { class: 'full' }, field('Note (facoltative)', notes))),
    actions,
  });

  async function save() {
    if (!v.amount_cents) { setFieldError(amount, 'Scrivi l’importo'); amount.focus(); return; }
    if (!isIsoDate(v.date)) { setFieldError(date, 'Scrivi la data'); date.focus(); return; }
    if (v.category === 'altro' && !String(v.label || '').trim()) { label.focus(); dlg.setBanner('Scrivi di cosa si tratta.'); return; }
    if (EXPENSE_CATEGORIES[v.category].period && v.period_from && v.period_to && v.period_to < v.period_from) {
      setFieldError(to, 'La fine è prima dell’inizio'); to.focus(); return;
    }
    const period = EXPENSE_CATEGORIES[v.category].period;
    const data = {
      house_id: v.house_id, category: v.category, label: String(v.label || '').trim(), amount_cents: v.amount_cents, date: v.date,
      period_from: period ? v.period_from : null, period_to: period ? v.period_to : null,
      due_date: v.paid ? null : v.due_date, paid: v.paid, notes: String(v.notes || '').trim(),
      booking_id: ['pulizie', 'lavanderia'].includes(v.category) ? v.booking_id : null,
    };
    try {
      if (existing) {
        const cur = store.data.expenses.find((e) => e.id === existing.id) || existing;
        const changes = {};
        for (const [k, val] of Object.entries(data)) if ((cur[k] ?? null) !== (val === '' ? null : val)) changes[k] = val;
        if (Object.keys(changes).length) await ctx.act('expense.update', { id: existing.id, version: cur.version, changes }, { message: 'Spesa aggiornata' });
      } else {
        const id = newId();
        await ctx.act('expense.add', { id, expense: data }, {
          optimistic: (s) => ({ ...s, expenses: [{ id, ...data, label: data.label || null, notes: data.notes || null, deleted: 0, version: 1, rev: -1 }, ...s.expenses] }),
          message: 'Spesa salvata',
          undo: () => ctx.act('expense.delete', { id }),
        });
      }
      dirty = false;
      dlg.close();
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
  async function remove() {
    const ok = await confirmDialog({ title: 'Eliminare questa spesa?', text: `${expenseLabel(existing)} · ${fmtEuro(existing.amount_cents)}`, okLabel: 'Elimina', danger: true });
    if (!ok) return;
    dirty = false;
    dlg.close();
    ctx.act('expense.delete', { id: existing.id }, {
      optimistic: (s) => ({ ...s, expenses: s.expenses.filter((e) => e.id !== existing.id) }),
      message: 'Spesa eliminata',
      undo: () => ctx.act('expense.restore', { id: existing.id }),
    }).catch(() => {});
  }
}

/* -------------------------------- Scadenze -------------------------------- */

/** "lun 21 dic", con l'anno se non è quello in corso. */
function withYear(iso, today) {
  return iso.slice(0, 4) === today.slice(0, 4) ? fmtShort(iso) : `${fmtShort(iso)} ${iso.slice(0, 4)}`;
}

function deadlinesView(ctx, house) {
  const { store, ui } = ctx;
  const all = store.data.deadlines.filter((x) => !x.house_id || x.house_id === house.id);
  const open = all.filter((x) => !x.done).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  const done = all.filter((x) => x.done);
  const houses = Object.fromEntries(store.data.houses.map((x) => [x.id, x]));

  const row = (x) => {
    const st = deadlineStatus(x, ui.today);
    const markDone = () => {
      const next = nextDue(x.due_date, x.repeat);
      ctx.act('deadline.done', { id: x.id, version: x.version }, {
        optimistic: (s) => ({ ...s, deadlines: s.deadlines.map((e) => (e.id === x.id ? (next ? { ...e, due_date: next } : { ...e, done: 1 }) : e)) }),
        message: next ? `Fatta. Prossima: ${withYear(next, ui.today)}` : 'Segnata come fatta',
        undo: (r) => ctx.act('deadline.update', { id: x.id, version: r.record.version, changes: next ? { due_date: x.due_date } : { done: false } }),
      }).catch(() => {});
    };
    const sub = [
      x.house_id ? houses[x.house_id]?.name : 'Tutte e due le case',
      withYear(x.due_date, ui.today),
      x.repeat !== 'none' ? REPEAT[x.repeat].toLowerCase() : null,
    ].filter(Boolean).join(' · ');
    return h('div', { class: 'row deadline-row' },
      h('button', { class: 'row-main row-button', type: 'button', onClick: () => deadlineDialog(ctx, x), attrs: { 'aria-label': `Apri: ${x.title}` } },
        h('span', { class: 'row-title', text: x.title }),
        h('span', { class: 'row-sub' }, tag({ text: st.label, tone: st.tone }), h('span', { text: sub }))),
      !x.done ? h('span', { class: 'row-end' },
        h('button', { class: 'btn small', type: 'button', onClick: markDone, attrs: { 'aria-label': `Segna fatta: ${x.title}` } }, icon('check', { size: 16 }), 'Fatta')) : null);
  };

  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      open.length ? h('div', { class: 'rows' }, open.map(row))
        : h('div', { class: 'empty', text: 'Nessuna scadenza. Aggiungi rinnovi, versamenti e controlli: ti avviso in Oggi prima della data.' })),
    done.length ? h('details', { class: 'card' },
      h('summary', { class: 'row muted small', text: `Fatte (${done.length})` }),
      h('div', { class: 'rows' }, done.map(row))) : null,
    h('p', { class: 'hint', text: 'Le scadenze che si ripetono, quando premi "Fatta", passano da sole alla data successiva.' }));
}

function deadlineDialog(ctx, existing) {
  const { store, ui } = ctx;
  const d = store.data;
  const v = existing ? { ...existing } : { title: '', house_id: null, due_date: '', repeat: 'none', notice_days: 30, notes: '' };
  let dirty = false;
  const touch = () => { dirty = true; };
  const title = h('input', { class: 'input', maxlength: '160', value: v.title, autocomplete: 'off', placeholder: 'es. Rinnovo assicurazione',
    onInput: (e) => { v.title = e.target.value; setFieldError(title, ''); touch(); } });
  const houseSel = h('select', { class: 'input', onChange: (e) => { v.house_id = e.target.value || null; touch(); } },
    h('option', { value: '', text: 'Tutte e due le case', selected: !v.house_id }),
    d.houses.map((x) => h('option', { value: x.id, text: x.name, selected: x.id === v.house_id })));
  const due = dateInput(v.due_date, 'Scadenza', (s) => { v.due_date = s; setFieldError(due, ''); touch(); });
  const rep = h('select', { class: 'input', onChange: (e) => { v.repeat = e.target.value; touch(); } },
    Object.entries(REPEAT).map(([k, t]) => h('option', { value: k, text: t, selected: k === v.repeat })));
  const notice = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'off', value: String(v.notice_days),
    onInput: (e) => { const n = parseInt(e.target.value, 10); v.notice_days = Number.isFinite(n) ? n : ''; setFieldError(notice, ''); touch(); } });
  const notes = h('textarea', { class: 'input', rows: '2', maxlength: '1000', onInput: (e) => { v.notes = e.target.value; touch(); } });
  notes.value = v.notes || '';

  const actions = [
    h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.requestClose() }),
    h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
  ];
  if (existing) actions.unshift(h('button', { class: 'btn danger ghost', type: 'button', text: 'Elimina', onClick: remove }));
  const dlg = openDialog({
    title: existing ? 'Modifica scadenza' : 'Nuova scadenza',
    canClose: () => !dirty || confirmDialog({ title: 'Uscire senza salvare?', text: 'La scadenza non verrà salvata.', okLabel: 'Esci senza salvare' }),
    content: h('div', { class: 'form-grid' },
      h('div', { class: 'full' }, field('Di cosa si tratta', title)),
      field('Casa', houseSel), field('Scadenza', due),
      field('Si ripete', rep), field('Avvisami prima (giorni)', notice, { hint: 'Compare in Oggi da quel momento' }),
      h('div', { class: 'full' }, field('Note (facoltative)', notes))),
    actions,
  });

  async function save() {
    if (!String(v.title).trim()) { setFieldError(title, 'Scrivi di cosa si tratta'); title.focus(); return; }
    if (!isIsoDate(v.due_date)) { setFieldError(due, 'Scegli la data'); due.focus(); return; }
    if (!Number.isInteger(v.notice_days) || v.notice_days < 0 || v.notice_days > 365) { setFieldError(notice, 'Da 0 a 365 giorni'); notice.focus(); return; }
    const data = { title: String(v.title).trim(), house_id: v.house_id, due_date: v.due_date, repeat: v.repeat, notice_days: v.notice_days, notes: String(v.notes || '').trim() };
    try {
      if (existing) {
        const cur = store.data.deadlines.find((e) => e.id === existing.id) || existing;
        const changes = {};
        for (const [k, val] of Object.entries(data)) if ((cur[k] ?? null) !== (val === '' ? null : val)) changes[k] = val;
        if (Object.keys(changes).length) await ctx.act('deadline.update', { id: existing.id, version: cur.version, changes }, { message: 'Scadenza aggiornata' });
      } else {
        const id = newId();
        await ctx.act('deadline.add', { id, deadline: data }, {
          optimistic: (s) => ({ ...s, deadlines: [...s.deadlines, { id, ...data, notes: data.notes || null, done: 0, deleted: 0, version: 1, rev: -1 }] }),
          message: 'Scadenza salvata',
          undo: () => ctx.act('deadline.delete', { id }),
        });
      }
      dirty = false;
      dlg.close();
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
  async function remove() {
    const ok = await confirmDialog({ title: 'Eliminare questa scadenza?', text: existing.title, okLabel: 'Elimina', danger: true });
    if (!ok) return;
    dirty = false;
    dlg.close();
    ctx.act('deadline.delete', { id: existing.id }, {
      optimistic: (s) => ({ ...s, deadlines: s.deadlines.filter((e) => e.id !== existing.id) }),
      message: 'Scadenza eliminata',
      undo: () => ctx.act('deadline.restore', { id: existing.id }),
    }).catch(() => {});
  }
}
