// Selettori: periodo di soggiorno (stile Airbnb, con date scrivibili a mano) e orario.
// Ogni selettore ridisegna solo sé stesso, mai il resto del modulo.

import { h, icon, nextId } from './dom.js';
import { formatItDate, isIsoDate, maskDate, maskTime, monthName, nights, parseItDate, parseTime, weekday } from '../shared/dates.js';
import { nextBlocked, rangeFree } from '../shared/booking.js';

const DOW = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];

/** Campo di testo con maschera (date gg/mm/aaaa o orari hh:mm). */
function maskedInput({ mask, placeholder, value, label, onValue, onComplete, maxLength }) {
  const input = h('input', {
    class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder, maxlength: String(maxLength),
    value, attrs: { 'aria-label': label, enterkeyhint: 'next' },
  });
  let deleting = false;
  input.addEventListener('keydown', (e) => { deleting = e.key === 'Backspace' || e.key === 'Delete'; });
  input.addEventListener('input', (e) => {
    const del = deleting || (e.inputType && e.inputType.startsWith('delete'));
    const masked = mask(input.value, del);
    if (masked !== input.value) {
      input.value = masked;
      input.setSelectionRange(masked.length, masked.length);
    }
    const done = onValue(masked);
    if (done && onComplete) onComplete();
  });
  return input;
}

/**
 * Periodo di soggiorno.
 * opts: { checkIn, checkOut, occupied: Set, today, onChange(checkIn, checkOut), houseName }
 * Restituisce { el, set(checkIn, checkOut), refreshOccupied(set) }.
 */
export function dateRangeField(opts) {
  let ci = isIsoDate(opts.checkIn) ? opts.checkIn : null;
  let co = isIsoDate(opts.checkOut) ? opts.checkOut : null;
  let occupied = opts.occupied || new Set();
  let shown = (ci || opts.today).slice(0, 7);
  const msgId = nextId('dr');
  const msg = h('div', { class: 'err', id: msgId, attrs: { role: 'alert' }, hidden: true });
  const summary = h('div', { class: 'hint' });

  const inIn = maskedInput({
    mask: maskDate, placeholder: 'gg/mm/aaaa', value: formatItDate(ci), label: 'Data di arrivo (gg/mm/aaaa)', maxLength: 10,
    onValue: (txt) => {
      if (txt.length < 8) { ci = null; update(false); return false; }
      const d = parseItDate(txt);
      if (!d) { showMsg('Data di arrivo non valida'); ci = null; update(false); return false; }
      ci = d;
      if (co && co <= ci) co = null;
      shown = ci.slice(0, 7);
      update(false);
      return txt.length === 10;
    },
    onComplete: () => { if (!co) inOut.focus(); },
  });
  const inOut = maskedInput({
    mask: maskDate, placeholder: 'gg/mm/aaaa', value: formatItDate(co), label: 'Data di partenza (gg/mm/aaaa)', maxLength: 10,
    onValue: (txt) => {
      if (txt.length < 8) { co = null; update(false); return false; }
      const d = parseItDate(txt);
      if (!d) { showMsg('Data di partenza non valida'); co = null; update(false); return false; }
      co = d;
      update(false);
      return txt.length === 10;
    },
  });

  const cal = h('div', { class: 'rp-cal' });
  const el = h('div', { class: 'rp' },
    h('div', { class: 'rp-inputs' },
      h('label', { class: 'rp-box' }, h('span', { class: 'rp-lbl', text: 'Arrivo' }), inIn),
      h('label', { class: 'rp-box' }, h('span', { class: 'rp-lbl', text: 'Partenza' }), inOut)),
    msg, summary, cal);

  function showMsg(text) {
    msg.textContent = text || '';
    msg.hidden = !text;
  }

  /** Problemi del periodo scelto (null se va bene). */
  function problem() {
    if (ci && co && co <= ci) return 'La partenza deve essere dopo l’arrivo.';
    if (ci && occupied.has(ci) && (!co || !rangeFree(occupied, ci, co))) return 'La data di arrivo è già occupata.';
    if (ci && co && !rangeFree(occupied, ci, co)) return 'Nel periodo scelto ci sono notti già occupate.';
    if (ci && co && nights(ci, co) > 90) return 'Soggiorno troppo lungo (massimo 90 notti).';
    return null;
  }

  function update(fromCalendar) {
    if (fromCalendar) {
      inIn.value = formatItDate(ci);
      inOut.value = formatItDate(co);
    }
    const p = problem();
    const typedBad = (inIn.value.length >= 8 && !parseItDate(inIn.value)) || (inOut.value.length >= 8 && !parseItDate(inOut.value));
    if (!typedBad) showMsg(p);
    inIn.setAttribute('aria-invalid', String(Boolean(p && !co) || (inIn.value.length >= 8 && !parseItDate(inIn.value))));
    inOut.setAttribute('aria-invalid', String(Boolean(p && co) || (inOut.value.length >= 8 && !parseItDate(inOut.value))));
    summary.textContent = ci && co && !p ? `${nights(ci, co)} ${nights(ci, co) === 1 ? 'notte' : 'notti'}`
      : ci && !co ? 'Ora scegli la data di partenza' : 'Tocca il giorno di arrivo, poi quello di partenza';
    drawCalendar();
    opts.onChange(ci, co, p);
  }

  function pick(day) {
    const choosingEnd = ci && !co;
    if (choosingEnd && day > ci) {
      if (rangeFree(occupied, ci, day)) { co = day; update(true); return; }
    }
    if (occupied.has(day)) return;
    ci = day;
    co = null;
    update(true);
  }

  function month(ym) {
    const [y, m] = ym.split('-').map(Number);
    const first = `${ym}-01`;
    const offset = (weekday(first) + 6) % 7;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const choosingEnd = ci && !co;
    const limit = choosingEnd ? nextBlocked(occupied, ci) : null;
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(h('span', { class: 'rp-empty', attrs: { 'aria-hidden': 'true' } }));
    for (let n = 1; n <= days; n++) {
      const day = `${ym}-${String(n).padStart(2, '0')}`;
      const occ = occupied.has(day);
      let disabled = occ;
      if (choosingEnd && day > ci) disabled = limit !== null && day > limit;
      if (choosingEnd && day > ci && day === limit) disabled = false;
      const start = day === ci;
      const end = day === co;
      const inRange = ci && co && day > ci && day < co;
      const cls = ['rp-day', occ && 'occ', start && 'start', end && 'end', inRange && 'range', (start || end) && 'sel',
        day === opts.today && 'today', day < opts.today && 'past', ci && co && start && 'has-range', ci && co && end && 'has-range'];
      const label = `${n} ${monthName(m)} ${y}${occ ? ', occupato' : ''}${start ? ', arrivo' : ''}${end ? ', partenza' : ''}`;
      cells.push(h('button', { class: cls, type: 'button', disabled, attrs: { 'aria-label': label, 'aria-pressed': String(start || end) },
        onClick: () => pick(day) }, h('span', { text: String(n) })));
    }
    return h('div', { class: 'rp-month' },
      h('div', { class: 'rp-title', text: `${monthName(m).charAt(0).toUpperCase()}${monthName(m).slice(1)} ${y}` }),
      h('div', { class: 'rp-grid' }, DOW.map((d) => h('span', { class: 'rp-dow', text: d, attrs: { 'aria-hidden': 'true' } })), cells));
  }

  function shift(delta) {
    const [y, m] = shown.split('-').map(Number);
    shown = new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
    drawCalendar();
  }

  function drawCalendar() {
    const [y, m] = shown.split('-').map(Number);
    const second = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
    cal.replaceChildren(
      h('div', { class: 'rp-nav' },
        h('button', { class: 'btn ghost icon-only', type: 'button', attrs: { 'aria-label': 'Mese precedente' }, onClick: () => shift(-1) }, icon('back')),
        h('div', { class: 'rp-legend' }, h('span', { class: 'rp-key occ' }), 'occupato'),
        h('button', { class: 'btn ghost icon-only', type: 'button', attrs: { 'aria-label': 'Mese successivo' }, onClick: () => shift(1) }, icon('chevron'))),
      h('div', { class: 'rp-months' }, month(shown), h('div', { class: 'rp-second' }, month(second))),
      ...(ci || co ? [h('button', { class: 'btn ghost small', type: 'button', text: 'Cancella le date',
        onClick: () => { ci = null; co = null; shown = opts.today.slice(0, 7); update(true); } })] : []));
  }

  update(false);
  return {
    el,
    get valid() { return Boolean(ci && co && !problem()); },
    get problem() { return problem() || (!ci ? 'Scegli la data di arrivo.' : !co ? 'Scegli la data di partenza.' : null); },
    set(newCi, newCo) { ci = newCi || null; co = newCo || null; shown = (ci || opts.today).slice(0, 7); update(true); },
    refreshOccupied(set) { occupied = set; update(false); },
    focus() { inIn.focus(); },
  };
}

/**
 * Orario: campo hh:mm con i due punti automatici e orari rapidi.
 * opts: { value, onChange(value|''|null), quick, label }
 */
export function timeField({ value = '', onChange, quick = ['14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00'], label = 'Orario' }) {
  const err = h('div', { class: 'err', hidden: true });
  let current = value || '';
  const chips = h('div', { class: 'chips' });
  const input = maskedInput({
    mask: maskTime, placeholder: 'hh:mm', value: current, label, maxLength: 5,
    onValue: (txt) => {
      const t = parseTime(txt);
      if (txt && t === null) {
        err.textContent = txt.length >= 4 ? 'Orario non valido (es. 16:30)' : '';
        err.hidden = txt.length < 4;
        current = null;
      } else {
        err.hidden = true;
        current = t;
      }
      drawChips();
      onChange(current);
      return false;
    },
  });
  input.addEventListener('blur', () => {
    const t = parseTime(input.value);
    if (t) input.value = t;
  });
  function drawChips() {
    chips.replaceChildren(...quick.map((q) => h('button', {
      type: 'button', class: ['chip', current === q && 'on'], text: q, attrs: { 'aria-pressed': String(current === q) },
      onClick: () => { current = q; input.value = q; err.hidden = true; drawChips(); onChange(q); },
    })), ...(current ? [h('button', { type: 'button', class: 'chip ghost', text: 'Togli', onClick: () => { current = ''; input.value = ''; drawChips(); onChange(''); } })] : []));
  }
  drawChips();
  const el = h('div', { class: 'time-field' }, input, chips, err);
  el.input = input;
  return { el, get value() { return current; }, input };
}
