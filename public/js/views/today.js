// Schermata Oggi: le due case insieme, avvisi, cose da fare.

import { h, icon, newId } from '../dom.js';
import { houseVars, tag, chan, alertIcon } from '../ui.js';
import { fmtLong, fmtRange, fmtShort, daysBetween, weekday, addDays } from '../../shared/dates.js';
import { buildList, pricingSettings, seasonYear, suggestionCount } from '../../shared/pricing.js';
import { CHANNELS, LEVEL_ORDER, bookingAlerts, currentAndNext, nextStep, phase, statusTags, guestsLabel } from '../../shared/booking.js';
import { runNextAction } from './actions.js';
import { draftBanner } from './form.js';
import { dateField } from '../pickers.js';
import { deadlineAlerts, expenseAlerts } from '../../shared/house.js';

export function renderToday(ctx) {
  const { store, ui } = ctx;
  const d = store.data;
  const year = Number(ui.today.slice(0, 4));
  const longDate = fmtLong(ui.today, year);

  return h('div', null,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', { text: 'Oggi' }), h('div', { class: 'sub', text: `${longDate.charAt(0).toUpperCase()}${longDate.slice(1)} · tutte e due le case` })),
      ctx.syncChip()),
    overdueBanner(ctx),
    demoBanner(ctx),
    draftBanner(ctx),
    pricingBanner(ctx),
    h('div', { class: 'grid-2' }, d.houses.map((house) => houseCard(ctx, house))),
    weekSection(ctx),
    alertsSection(ctx),
    tasksSection(ctx));
}

/** In cima a Oggi: check-in non conclusi oltre le 24 ore dall'arrivo (Alloggiati e DMS sono obbligatori). */
function overdueBanner(ctx) {
  const d = ctx.store.data;
  const late = d.bookings.flatMap((b) => bookingAlerts(b, ctx.ui.today, [], ctx.clock(b))
    .filter((a) => a.key === 'checkin' && a.level === 'urgente').map((a) => ({ a, b })));
  if (!late.length) return null;
  const houses = Object.fromEntries(d.houses.map((x) => [x.id, x]));
  return h('div', { class: 'banner bad urgent-list', attrs: { role: 'alert' } },
    h('strong', { text: late.length === 1 ? 'Check-in da completare subito' : `${late.length} check-in da completare subito` }),
    late.map(({ a, b }) => h('div', { class: 'urgent-item' },
      h('span', { text: `${houses[b.house_id]?.name || ''} · ${b.guest_name}: ${a.text}` }),
      h('button', { class: 'btn small', type: 'button', text: 'Completa il check-in', onClick: () => runNextAction(ctx, b, 'checkin') }))));
}

/**
 * Il lunedì, da gennaio ad agosto (quando Mattia rivede i prezzi): quante settimane del listino hanno un suggerimento.
 * Solo per l'amministratore, che è l'unico a cambiare il listino.
 */
function pricingBanner(ctx) {
  const { store, ui } = ctx;
  const d = store.data;
  if (d.me.role !== 'admin' || weekday(ui.today) !== 1 || Number(ui.today.slice(5, 7)) > 8) return null;
  const counts = d.houses.map((house) => {
    const year = seasonYear(ui.today, pricingSettings(house));
    return { house, n: suggestionCount(buildList({ bookings: d.bookings, prices: d.prices, extras: d.extras, house, year, today: ui.today })) };
  }).filter((x) => x.n);
  const total = counts.reduce((s, x) => s + x.n, 0);
  if (!total) return null;
  return h('div', { class: 'banner pl-banner' },
    h('span', null, h('strong', { text: 'Lunedì dei prezzi: ' }),
      `${total === 1 ? '1 settimana da valutare' : `${total} settimane da valutare`} nel listino (${counts.map((x) => `${x.house.name} ${x.n}`).join(', ')}).`),
    h('button', { class: 'btn small', type: 'button', text: 'Apri il listino', onClick: () => { if (counts.length === 1) ctx.setHouse(counts[0].house.id, { silent: true }); ctx.go('preventivo/listino'); } }));
}

/**
 * I prossimi 7 giorni delle due case: arrivi, partenze e cambi (partenza e arrivo nello stesso giorno, con le pulizie
 * in mezzo). Su iPad e computer una colonna per giorno; sul telefono un elenco dei giorni con qualcosa da fare.
 */
function weekSection(ctx) {
  const { store, ui } = ctx;
  const d = store.data;
  const DOW = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
  const first = (s) => String(s).replace(/\s*\(prova\)$/, '').split(/\s+/)[0];
  const active = d.bookings.filter((b) => b.stage !== 'cancellata');
  const days = Array.from({ length: 7 }, (_, i) => addDays(ui.today, i)).map((day) => ({
    day,
    houses: d.houses.map((house) => {
      const arr = active.filter((b) => b.house_id === house.id && b.check_in === day);
      const dep = active.filter((b) => b.house_id === house.id && b.check_out === day);
      return { house, arr, dep };
    }).filter((x) => x.arr.length || x.dep.length),
  }));
  const busy = days.filter((x) => x.houses.length).length;
  const event = ({ house, arr, dep }) => {
    const change = arr.length && dep.length;
    const lines = [
      ...dep.map((b) => ({ k: 'dep', text: `Parte ${first(b.guest_name)}`, b })),
      ...arr.map((b) => ({ k: 'arr', text: `Arriva ${first(b.guest_name)} (${b.guests})`, b })),
    ];
    return h('div', { class: ['wk-ev', change && 'change'], vars: houseVars(house) },
      h('div', { class: 'wk-ev-head' }, h('span', { class: 'house-dot' }), h('strong', { text: house.short_name || house.name }),
        change ? h('span', { class: 'wk-tag', text: 'Cambio' }) : null),
      lines.map((l) => h('a', { class: ['wk-line', l.k], href: `#/p/${l.b.id}` }, icon(l.k === 'arr' ? 'home' : 'door', { size: 14 }), h('span', { text: l.text }))));
  };
  return h('section', { class: 'section', attrs: { 'aria-label': 'Prossimi 7 giorni' } },
    h('div', { class: 'section-head' }, h('h2', { text: 'Prossimi 7 giorni' }),
      h('span', { class: 'muted small', text: busy ? `${busy} ${busy === 1 ? 'giorno' : 'giorni'} con arrivi o partenze` : 'Nessun arrivo né partenza' })),
    !busy ? h('div', { class: 'card' }, h('div', { class: 'empty', text: 'Nessun arrivo né partenza nei prossimi 7 giorni.' })) : h('div', { class: 'card wk' }, days.map((x) => {
      const n = Number(x.day.slice(8));
      const label = x.day === ui.today ? 'Oggi' : x.day === addDays(ui.today, 1) ? 'Domani' : DOW[weekday(x.day)];
      return h('div', { class: ['wk-day', !x.houses.length && 'empty', x.houses.some((e) => e.arr.length && e.dep.length) && 'has-change', x.day === ui.today && 'today'] },
        h('div', { class: 'wk-date' }, h('span', { class: 'wk-dow', text: label }), h('span', { class: 'wk-n', text: String(n) })),
        x.houses.length ? x.houses.map(event) : h('span', { class: 'wk-none', text: '—', attrs: { 'aria-label': 'Nessun arrivo o partenza' } }));
    })));
}

function demoBanner(ctx) {
  const d = ctx.store.data;
  if (!ctx.store.info.demo || d.bookings.length) return null;
  return h('div', { class: 'banner' },
    h('span', { text: 'Non ci sono ancora prenotazioni. Per provare il gestionale puoi caricare dei dati inventati.' }),
    d.me.role === 'admin' ? h('button', { class: 'btn small', type: 'button', text: 'Vai alle impostazioni', onClick: () => ctx.go('impostazioni') }) : null);
}

function houseCard(ctx, house) {
  const { store, ui } = ctx;
  const d = store.data;
  const { current, next } = currentAndNext(d.bookings, house.id, ui.today);
  const openHouse = () => { ctx.setHouse(house.id); ctx.go('prenotazioni'); };
  const ph = current ? phase(current, ui.today, ctx.clock(current)) : null;

  const top = h('button', { class: 'house-top', type: 'button', onClick: openHouse, attrs: { 'aria-label': `Apri le prenotazioni di ${house.name}` } },
    h('span', { class: 'name', text: house.name }),
    h('span', { class: 'pill', text: ph ? ph.label : 'Libera' }));

  let body;
  if (current) {
    const step = nextStep(current, ui.today, house, ui.now);
    body = h('div', { class: 'house-body' },
      h('a', { href: `#/p/${current.id}`, class: 'stack' },
        h('div', null,
          h('div', { class: 'guest', text: current.guest_name }),
          h('div', { class: 'guest-meta' }, `${guestsLabel(current)} · ${fmtRange(current.check_in, current.check_out)} · `, CHANNELS[current.channel].label))),
      h('div', { class: 'tags' }, statusTags(current, ui.today).map(tag)),
      h('div', { class: ['next-box', step.urgent && 'urgent'] },
        h('div', { class: 'next-label', text: 'Prossimo passo' }),
        h('div', { text: step.text }),
        step.action ? h('button', { class: 'btn house', type: 'button', text: step.label, onClick: () => runNextAction(ctx, current, step.action) }) : null),
      quickNotes(ctx, current));
  } else {
    body = h('div', { class: 'house-body' },
      h('p', { class: 'empty-house', text: 'Nessun ospite in casa.' }),
      next ? h('a', { class: 'row card', href: `#/p/${next.id}` },
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title', text: next.guest_name }),
          h('span', { class: 'row-sub' }, `Arrivo ${fmtShort(next.check_in)} · ${guestsLabel(next)}`, chan(next.channel))),
        h('span', { class: 'row-end' }, icon('chevron'))) : null);
  }

  let footText;
  const after = current ? next : (next ? currentAndNext(d.bookings.filter((b) => b.id !== next.id), house.id, ui.today).next : null);
  if (current && next) {
    const free = daysBetween(current.check_out, next.check_in);
    footText = `Prossimo arrivo: ${fmtShort(next.check_in)} · ${guestsLabel(next)} · ${free === 0 ? 'cambio lo stesso giorno' : free === 1 ? '1 notte libera' : `${free} notti libere`}`;
  } else if (current) footText = 'Nessun altro arrivo in programma';
  else if (after) footText = `Poi: ${fmtShort(after.check_in)} · ${after.guest_name}`;
  else footText = next ? 'Nessun altro arrivo dopo questo' : 'Nessun arrivo in programma';

  return h('section', { class: 'card house-card', vars: houseVars(house), attrs: { 'aria-label': house.name } },
    top, body, h('div', { class: 'house-foot', text: footText }));
}

function quickNotes(ctx, booking) {
  const notes = ctx.store.data.notes.filter((n) => n.booking_id === booking.id).slice(-2);
  const key = `note-${booking.id}`;
  const input = h('input', {
    class: 'input', type: 'text', placeholder: 'Scrivi una nota…', maxlength: '1000',
    dataset: { key }, value: ctx.ui.drafts[key] || '', attrs: { 'aria-label': `Nuova nota per ${booking.guest_name}` },
    onInput: (e) => { ctx.ui.drafts[key] = e.target.value; },
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } },
  });
  function save() {
    const text = (ctx.ui.drafts[key] || '').trim();
    if (!text) return;
    const id = newId();
    ctx.ui.drafts[key] = '';
    input.value = '';
    const optimistic = (d) => ({ ...d, notes: [...d.notes, { id, booking_id: booking.id, text, created_at: new Date().toISOString(), created_by: d.me.email, rev: -1 }] });
    ctx.act('note.add', { id, bookingId: booking.id, text }, {
      optimistic, message: 'Nota salvata',
      undo: () => ctx.act('note.delete', { id }, { message: 'Nota eliminata' }),
    }).catch(() => { ctx.ui.drafts[key] = text; ctx.render(); });
  }
  return h('div', { class: 'stack' },
    notes.length ? h('div', { class: 'stack' }, notes.map((n) => h('div', { class: 'note' }, h('div', { class: 'note-text', text: n.text })))) : null,
    h('div', { class: 'btn-row' }, input, h('button', { class: 'btn', type: 'button', text: 'Salva', onClick: save })));
}

function alertsSection(ctx) {
  const { store, ui } = ctx;
  const d = store.data;
  const houses = Object.fromEntries(d.houses.map((x) => [x.id, x]));
  // Le cose da fare scadute si vedono già nel loro elenco, con l'etichetta "scaduta".
  // Calendari di Airbnb/Booking che non si aggiornano (li vede solo l'amministratore, che può sistemarli).
  const calAlerts = (d.calendars || []).filter((c) => c.connected && c.last_error).map((c) => ({
    level: 'attenzione', key: 'calendar', houseId: c.house_id, href: '#/impostazioni',
    text: `Calendario ${c.channel === 'airbnb' ? 'Airbnb' : 'Booking'} non aggiornato: ${c.last_error}`,
  }));
  // Archivio della casa: scadenze vicine o passate e spese da pagare.
  const houseAlerts = [...deadlineAlerts(d.deadlines || [], ui.today), ...expenseAlerts(d.expenses || [], ui.today)]
    .map((a) => ({ ...a, href: `#/archivio/${a.key === 'deadline' ? 'scadenze' : 'spese'}${a.houseId ? `/${a.houseId}` : ''}` }));
  const all = [...calAlerts, ...houseAlerts, ...d.bookings.flatMap((b) => bookingAlerts(b, ui.today, d.bookings, ctx.clock(b)).map((a) => ({ ...a, guest: b.guest_name })))]
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  return h('section', { class: 'section', attrs: { 'aria-label': 'Da sistemare' } },
    h('div', { class: 'section-head' }, h('h2', { text: 'Da sistemare' }), all.length ? h('span', { class: 'muted small', text: `${all.length}` }) : null),
    h('div', { class: 'card' }, all.length
      ? h('div', { class: 'rows' }, all.map((a) => {
        const house = houses[a.houseId];
        const inner = [
          h('span', { class: ['lvl', a.level] }, alertIcon(a.key)),
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title', text: a.text }),
            h('span', { class: 'row-sub' },
              house ? h('span', { class: 'house-dot', vars: houseVars(house) }) : null,
              [house ? house.name : 'Generale', a.guest].filter(Boolean).join(' · '))),
        ];
        const href = a.href || (a.bookingId ? `#/p/${a.bookingId}` : null);
        return href
          ? h('a', { class: 'row alert-row', href }, inner, h('span', { class: 'row-end' }, icon('chevron')))
          : h('div', { class: 'row alert-row' }, inner);
      }))
      : h('div', { class: 'empty', text: 'Niente da sistemare. Tutto in ordine.' })));
}

function tasksSection(ctx) {
  const { store, ui } = ctx;
  const d = store.data;
  const houses = Object.fromEntries(d.houses.map((x) => [x.id, x]));
  const users = Object.fromEntries(d.users.map((u) => [u.id, u]));
  const open = d.tasks.filter((t) => !t.done);
  const done = d.tasks.filter((t) => t.done).sort((a, b) => (a.done_at < b.done_at ? 1 : -1)).slice(0, 5);

  const row = (t) => {
    const house = houses[t.house_id];
    const late = !t.done && t.due_date && t.due_date < ui.today;
    const sub = [
      house ? house.name : 'Tutte e due',
      t.due_date ? (t.due_date === ui.today ? 'oggi' : fmtShort(t.due_date)) : null,
      t.assignee && users[t.assignee] ? users[t.assignee].name : null,
    ].filter(Boolean).join(' · ');
    const toggle = () => {
      const target = !t.done;
      const optimistic = (s) => ({ ...s, tasks: s.tasks.map((x) => (x.id === t.id ? { ...x, done: target ? 1 : 0, done_at: target ? new Date().toISOString() : null } : x)) });
      ctx.act('task.toggle', { id: t.id, done: target }, {
        optimistic,
        message: target ? `Fatto: ${t.title}` : null,
        undo: target ? () => ctx.act('task.toggle', { id: t.id, done: false }, {
          optimistic: (s) => ({ ...s, tasks: s.tasks.map((x) => (x.id === t.id ? { ...x, done: 0 } : x)) }),
        }) : undefined,
      }).catch(() => {});
    };
    const remove = () => {
      ctx.act('task.delete', { id: t.id }, {
        optimistic: (s) => ({ ...s, tasks: s.tasks.filter((x) => x.id !== t.id) }),
        message: 'Eliminata',
        undo: () => ctx.act('task.restore', { id: t.id }),
      }).catch(() => {});
    };
    return h('div', { class: ['row', 'task-row', t.done && 'done'], vars: houseVars(house) },
      h('button', { class: 'btn ghost icon-only', type: 'button', onClick: toggle,
        attrs: { 'aria-pressed': String(Boolean(t.done)), 'aria-label': `${t.done ? 'Segna da fare' : 'Segna fatto'}: ${t.title}` } },
      h('span', { class: ['check', t.done && 'on'] }, t.done ? icon('check', { size: 14 }) : null)),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title', text: t.title }),
        h('span', { class: 'row-sub' }, house ? h('span', { class: 'house-dot' }) : null, sub, late ? h('span', { class: 'tag warn', text: 'scaduta' }) : null)),
      h('button', { class: 'btn ghost icon-only small', type: 'button', onClick: remove, attrs: { 'aria-label': `Elimina: ${t.title}` } }, icon('trash', { size: 16 })));
  };

  return h('section', { class: 'section', attrs: { 'aria-label': 'Cose da fare' } },
    h('div', { class: 'section-head' }, h('h2', { text: 'Cose da fare' })),
    h('div', { class: 'card' },
      open.length ? h('div', { class: 'rows' }, open.map(row)) : h('div', { class: 'empty', text: 'Nessuna cosa da fare.' }),
      addTask(ctx),
      done.length ? h('details', null,
        h('summary', { class: 'row muted small', text: `Fatte di recente (${done.length})` }),
        h('div', { class: 'rows' }, done.map(row))) : null));
}

function addTask(ctx) {
  const { ui, store } = ctx;
  const d = store.data;
  const k = (s) => `task-${s}`;
  const title = h('input', { class: 'input', type: 'text', placeholder: 'Nuova cosa da fare…', maxlength: '200', dataset: { key: k('title') },
    value: ui.drafts[k('title')] || '', attrs: { 'aria-label': 'Nuova cosa da fare' },
    onInput: (e) => { ui.drafts[k('title')] = e.target.value; },
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } } });
  const house = h('select', { class: 'input', dataset: { key: k('house') }, attrs: { 'aria-label': 'Casa' }, onChange: (e) => { ui.drafts[k('house')] = e.target.value; } },
    h('option', { value: '', text: 'Tutte e due' }),
    d.houses.map((x) => h('option', { value: x.id, text: x.name, selected: ui.drafts[k('house')] === x.id })));
  const dueField = dateField({ value: ui.drafts[k('due')] || '', label: 'Entro il (gg/mm/aaaa)', today: ui.today, min: ui.today,
    onChange: (iso) => { ui.drafts[k('due')] = iso; } });
  dueField.input.dataset.key = k('due');
  const due = dueField.el;
  const who = h('select', { class: 'input', dataset: { key: k('who') }, attrs: { 'aria-label': 'Assegnata a' }, onChange: (e) => { ui.drafts[k('who')] = e.target.value; } },
    h('option', { value: '', text: 'Nessuno in particolare' }),
    d.users.filter((u) => u.active).map((u) => h('option', { value: u.id, text: u.name, selected: ui.drafts[k('who')] === u.id })));
  house.style.flex = '0 1 170px';
  due.style.flex = '1 1 230px';
  who.style.flex = '0 1 200px';

  function save() {
    const t = (ui.drafts[k('title')] || '').trim();
    if (!t) { title.focus(); return; }
    const task = { title: t, house_id: ui.drafts[k('house')] || null, due_date: ui.drafts[k('due')] || null, assignee: ui.drafts[k('who')] || null };
    const id = newId();
    ui.drafts[k('title')] = '';
    title.value = '';
    ctx.act('task.add', { id, task }, {
      optimistic: (s) => ({ ...s, tasks: [...s.tasks, { id, ...task, done: 0, deleted: 0, rev: -1 }] }),
      message: 'Aggiunta',
      undo: () => ctx.act('task.delete', { id }),
    }).catch(() => { ui.drafts[k('title')] = t; ctx.render(); });
  }
  return h('div', { class: 'task-add' }, title, house, due, who, h('button', { class: 'btn', type: 'button', onClick: save }, icon('plus'), 'Aggiungi'));
}
