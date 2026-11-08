// Prenotazioni di una casa: elenco per fase e calendario.

import { h, icon } from '../dom.js';
import { houseVars, segmented, chan } from '../ui.js';
import { addDays, fmtShort, fmtRange, monthName, nights, weekday } from '../../shared/dates.js';
import { phase } from '../../shared/booking.js';
import { openBookingForm, draftBanner } from './form.js';

export function renderBookings(ctx) {
  const { store, ui } = ctx;
  const d = store.data;
  const house = d.houses.find((x) => x.id === ui.houseId);
  const mine = d.bookings.filter((b) => b.house_id === house.id);

  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', { text: 'Prenotazioni' })),
    h('div', { class: 'btn-row' },
      ctx.syncChip(),
      h('button', { class: 'btn house', type: 'button', vars: houseVars(house), onClick: () => openBookingForm(ctx) }, icon('plus'), 'Nuova prenotazione')));

  const switches = h('div', { class: 'btn-row' },
    segmented(d.houses.map((x) => ({ value: x.id, label: x.name, swatch: true, vars: houseVars(x) })), house.id, (id) => ctx.setHouse(id), 'Casa'),
    segmented([{ value: 'elenco', label: 'Elenco' }, { value: 'calendario', label: 'Calendario' }], ui.bookingsView, (v) => {
      ui.bookingsView = v;
      try { localStorage.setItem('gc.bview', v); } catch { /* nessun problema */ }
      ctx.render();
    }, 'Vista'));
  switches.style.marginBottom = '20px';

  return h('div', { vars: houseVars(house) },
    head, draftBanner(ctx), switches,
    ui.bookingsView === 'calendario' ? calendar(ctx, house, mine) : list(ctx, house, mine));
}

function list(ctx, house, mine) {
  const { ui } = ctx;
  const thisYear = Number(ui.today.slice(0, 4));
  const years = [...new Set([thisYear, ...mine.map((b) => Number(b.check_in.slice(0, 4)))])].sort((a, b) => b - a);
  const season = ui.season && years.includes(ui.season) ? ui.season : thisYear;
  const inSeason = mine.filter((b) => Number(b.check_in.slice(0, 4)) === season
    || (season === thisYear && b.stage !== 'chiusa' && b.stage !== 'cancellata' && b.check_out >= ui.today));

  const groups = [
    { key: 'subito', title: 'Da sistemare subito', test: (p) => p.key === 'checkin_ritardo' || p.key === 'checkout_mancante' },
    { key: 'corso', title: 'Check-in in corso', test: (p) => p.key === 'checkin_corso' },
    { key: 'casa', title: 'In casa', test: (p) => ['in_casa', 'parte_oggi'].includes(p.key) },
    { key: 'arrivo', title: 'In arrivo', test: (p) => ['arriva_oggi', 'in_arrivo', 'confermata'].includes(p.key) },
    { key: 'chiudere', title: 'Da chiudere', test: (p) => p.key === 'partita' },
    { key: 'chiuse', title: 'Chiuse', test: (p) => p.key === 'chiusa', reverse: true },
    { key: 'cancellate', title: 'Cancellate', test: (p) => p.key === 'cancellata', reverse: true },
  ];

  const seasonSel = h('select', { class: 'input', attrs: { 'aria-label': 'Stagione' },
    onChange: (e) => { ui.season = Number(e.target.value); ctx.render(); } },
  years.map((y) => h('option', { value: String(y), text: `Stagione ${y}${y === thisYear ? ' (in corso)' : ''}`, selected: y === season })));
  seasonSel.style.width = 'auto';
  seasonSel.style.flex = '0 0 auto';

  const blocks = groups.map((g) => {
    let items = inSeason.filter((b) => g.test(phase(b, ui.today, ctx.clock(b))));
    if (g.reverse) items = items.slice().reverse();
    if (!items.length) return null;
    const rows = h('div', { class: 'card' }, h('div', { class: 'rows' }, items.map((b) => bookingRow(ctx, b))));
    if (g.key === 'chiuse' || g.key === 'cancellate') {
      return h('details', { open: season !== thisYear && g.key === 'chiuse' },
        h('summary', { class: 'group-title', text: `${g.title} (${items.length})` }), rows);
    }
    return h('div', null, h('div', { class: 'group-title', text: `${g.title} (${items.length})` }), rows);
  }).filter(Boolean);

  return h('div', null,
    h('div', { class: 'btn-row' }, seasonSel,
      season !== thisYear ? h('span', { class: 'muted small', text: 'Archivio: stagione passata' }) : null),
    h('div', { class: 'section groups' },
      blocks.length ? blocks : h('div', { class: 'card' }, h('div', { class: 'empty' },
        h('p', { text: `Nessuna prenotazione per ${house.name} in questa stagione.` }),
        h('p', { class: 'small', text: 'Usa “Nuova prenotazione” per aggiungerne una.' })))));
}

function bookingRow(ctx, b) {
  const p = phase(b, ctx.ui.today, ctx.clock(b));
  const tone = ['checkin_ritardo', 'checkout_mancante'].includes(p.key) ? 'bad'
    : ['arriva_oggi', 'checkin_corso', 'parte_oggi', 'partita'].includes(p.key) ? 'warn'
      : p.key === 'in_casa' ? 'ok' : '';
  const n = nights(b.check_in, b.check_out);
  return h('a', { class: 'row', href: `#/p/${b.id}` },
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title', text: b.guest_name }),
      h('span', { class: 'row-sub' }, `${fmtRange(b.check_in, b.check_out)} · ${n} ${n === 1 ? 'notte' : 'notti'} · ${b.guests} persone`, chan(b.channel))),
    h('span', { class: 'row-end' }, h('span', { class: ['tag', tone], text: p.label }), icon('chevron')));
}

function calendar(ctx, house, mine) {
  const { ui } = ctx;
  const month = ui.calMonth || ui.today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const startOffset = (weekday(first) + 6) % 7; // lunedì = 0
  const gridStart = addDays(first, -startOffset);
  const active = mine.filter((b) => b.stage !== 'cancellata');
  const shift = (delta) => {
    const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
    ui.calMonth = dt.toISOString().slice(0, 7);
    ctx.render();
  };

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    if (i >= 35 && day.slice(0, 7) !== month) break;
    const staying = active.find((b) => b.check_in <= day && day < b.check_out);
    const leaving = active.find((b) => b.check_out === day && b !== staying);
    const label = [];
    const n = Number(day.slice(8));
    const cls = ['cal-day', day.slice(0, 7) !== month && 'out', day === ui.today && 'today'];
    const bars = [];
    if (leaving) bars.push(h('span', { class: 'cal-bar leave', text: `↤ ${firstWord(leaving.guest_name)}` }));
    if (staying) {
      const start = staying.check_in === day || (i % 7 === 0);
      bars.push(h('span', { class: ['cal-bar', staying.check_in !== day && 'cont'], text: start ? firstWord(staying.guest_name) : ' ' }));
      label.push(`occupato da ${staying.guest_name}`);
    } else label.push('libero');
    if (leaving) label.push(`partenza di ${leaving.guest_name}`);
    cells.push(h('button', {
      class: cls, type: 'button',
      attrs: { 'aria-label': `${fmtShort(day)}: ${label.join(', ')}` },
      onClick: () => (staying ? ctx.go(`p/${staying.id}`) : openBookingForm(ctx, { preset: { check_in: day, house_id: house.id } })),
    }, h('span', { class: 'cal-n', text: String(n) }), bars));
  }

  return h('div', { class: 'card' },
    h('div', { class: 'cal-head' },
      h('button', { class: 'btn ghost icon-only', type: 'button', onClick: () => shift(-1), attrs: { 'aria-label': 'Mese precedente' } }, icon('back')),
      h('h2', { text: `${monthName(m).charAt(0).toUpperCase()}${monthName(m).slice(1)} ${y}` }),
      h('div', { class: 'btn-row' },
        month !== ui.today.slice(0, 7) ? h('button', { class: 'btn small', type: 'button', text: 'Oggi', onClick: () => { ui.calMonth = null; ctx.render(); } }) : null,
        h('button', { class: 'btn ghost icon-only', type: 'button', onClick: () => shift(1), attrs: { 'aria-label': 'Mese successivo' } }, icon('chevron')))),
    h('div', { class: 'cal-grid' },
      ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'].map((x) => h('div', { class: 'cal-dow', text: x, attrs: { 'aria-hidden': 'true' } })),
      cells),
    h('div', { class: 'house-foot', text: 'Tocca un giorno libero per creare una prenotazione da quella data, o un giorno occupato per aprirla.' }));
}

function firstWord(name) {
  return String(name).replace(/\s*\(prova\)$/, '').split(/\s+/).slice(0, 2).join(' ');
}
