// Pezzi di interfaccia riusati: finestre, campi, etichette.

import { h, icon, nextId } from './dom.js';

/** Applica i colori di una casa a un elemento (variabili CSS). */
export function houseVars(house) {
  if (!house) return {};
  return { '--house': house.color, '--house-dark': house.color_dark, '--house-soft': house.color_soft };
}

export function tag(t) {
  return h('span', { class: ['tag', t.tone], text: t.text });
}

export function chan(channel) {
  const labels = { diretto: 'Diretto', airbnb: 'Airbnb', booking: 'Booking' };
  return h('span', { class: ['chan', channel], text: labels[channel] || channel });
}

/**
 * Finestra modale. Restituisce { el, body, close, setBanner }.
 * La finestra non viene mai ridisegnata dagli aggiornamenti dei dati: quello che scrivi resta.
 */
export function openDialog({ title, content, actions = [], onClose, wide = false, canClose }) {
  const titleId = nextId('dlg');
  const banner = h('div', { class: 'banner warn', hidden: true, attrs: { role: 'alert' } });
  const body = h('div', { class: 'dlg-body' }, banner, content);
  const foot = actions.length ? h('div', { class: 'dlg-foot' }, actions) : null;
  const dlg = h('dialog', { attrs: { 'aria-labelledby': titleId }, class: wide ? 'wide' : null },
    h('div', { class: 'dlg' },
      h('div', { class: 'dlg-head' },
        h('h2', { id: titleId, text: title }),
        h('button', { class: 'btn ghost icon-only', type: 'button', attrs: { 'aria-label': 'Chiudi' }, onClick: () => requestClose() }, icon('close'))),
      body, foot));
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (dlg.open) dlg.close();
    dlg.remove();
    if (onClose) onClose();
  }
  // Chiudere costa una scelta esplicita (X, Annulla, Esc). Toccare fuori dalla finestra NON la chiude:
  // sull'iPad chiudere la tastiera o il selettore di date/orari genera tocchi "fuori" involontari.
  async function requestClose() {
    if (closed) return;
    if (canClose && !(await canClose())) return;
    close();
  }
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); requestClose(); });
  document.body.append(dlg);
  dlg.showModal();
  const first = body.querySelector('input:not([type=hidden]), select, textarea');
  if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
  return {
    el: dlg, body, close, requestClose,
    get closed() { return closed; },
    setBanner(text, extra) {
      banner.replaceChildren();
      if (!text) { banner.hidden = true; return; }
      banner.append(h('span', { text }), extra || null);
      banner.hidden = false;
    },
  };
}

/** Chiede conferma prima di un'azione importante. Restituisce una promessa true/false. */
export function confirmDialog({ title, text, okLabel = 'Conferma', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { if (!answered) { answered = true; resolve(v); } d.close(); };
    const d = openDialog({
      title,
      content: h('p', { text }),
      actions: [
        h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => done(false) }),
        h('button', { class: ['btn', danger ? 'danger' : 'primary'], type: 'button', text: okLabel, onClick: () => done(true) }),
      ],
      onClose: () => { if (!answered) { answered = true; resolve(false); } },
    });
  });
}

/** Campo con etichetta ed eventuale messaggio d'errore. */
export function field(label, control, { hint, error, full = false } = {}) {
  const id = control.id || nextId('in');
  control.id = id;
  const errId = `${id}-err`;
  const err = h('div', { class: 'err', id: errId, hidden: !error, text: error || '' });
  if (error) { control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-describedby', errId); }
  return h('div', { class: ['field', full && 'full'] },
    h('label', { for: id, text: label }), control,
    hint ? h('div', { class: 'hint', text: hint }) : null, err);
}

export function setFieldError(control, message) {
  const wrap = control.closest('.field');
  const err = wrap && wrap.querySelector('.err');
  if (!err) return;
  err.textContent = message || '';
  err.hidden = !message;
  if (message) { control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-describedby', err.id); }
  else control.removeAttribute('aria-invalid');
}

export function switchRow(label, { checked, onChange, id, hint }) {
  const inputId = id || nextId('sw');
  const input = h('input', { type: 'checkbox', id: inputId, role: 'switch', checked, onChange: (e) => onChange && onChange(e.target.checked) });
  return h('div', { class: 'field' },
    h('div', { class: 'switch-row' },
      h('label', { for: inputId, text: label }),
      h('span', { class: 'switch' }, input, h('span'))),
    hint ? h('div', { class: 'hint', text: hint }) : null);
}

export function segmented(options, value, onChange, label) {
  return h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': label } },
    options.map((o) => h('button', {
      type: 'button', attrs: { 'aria-pressed': String(o.value === value) }, vars: o.vars,
      onClick: () => { if (o.value !== value) onChange(o.value); },
    }, o.swatch ? h('span', { class: 'swatch' }) : null, o.label)));
}
