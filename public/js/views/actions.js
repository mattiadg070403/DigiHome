// Azioni sulle prenotazioni usate da più schermate (pulsante "prossimo passo", chiusura, cancellazione).

import { h } from '../dom.js';
import { openDialog, confirmDialog, field, switchRow } from '../ui.js';
import { timeField } from '../pickers.js';

export function runNextAction(ctx, b, action) {
  if (action === 'checkin') return ctx.go(`p/${b.id}/checkin`);
  if (action === 'checkout') return ctx.go(`p/${b.id}/checkout`);
  if (action === 'close') return closeDialog(ctx, b);
  if (action === 'arrival') return arrivalDialog(ctx, b);
  return null;
}

/** Copia dei dati con un passaggio spuntato o tolto, per mostrarlo subito. */
export function patchSteps(d, id, col, key, value) {
  return {
    ...d,
    bookings: d.bookings.map((x) => {
      if (x.id !== id) return x;
      let cur = {};
      try { cur = JSON.parse(x[col] || '{}'); } catch { cur = {}; }
      return { ...x, [col]: JSON.stringify({ ...cur, [key]: value }) };
    }),
  };
}

function latest(ctx, id) {
  return ctx.store.data.bookings.find((x) => x.id === id);
}

export function arrivalDialog(ctx, b) {
  let value = b.arrival_time || '';
  const time = timeField({ value, label: 'Orario di arrivo', onChange: (t) => { value = t; } });
  const dlg = openDialog({
    title: 'Orario di arrivo',
    content: h('div', { class: 'field' }, h('div', { class: 'label', text: `A che ora arriva ${b.guest_name}?` }), time.el,
      h('div', { class: 'hint', text: 'Scrivi le cifre (es. 1630) oppure tocca un orario.' })),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
    ],
  });
  async function save() {
    if (value === null) { dlg.setBanner('Orario non valido (es. 16:30).'); return; }
    const cur = latest(ctx, b.id);
    try {
      await ctx.act('booking.update', { id: b.id, version: cur.version, changes: { arrival_time: value || null } }, { message: 'Orario salvato' });
      dlg.close();
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
}

export function closeDialog(ctx, b) {
  let review = null;
  const choice = h('div', { class: 'stack' },
    h('p', { text: 'Gli ospiti sono partiti e il check-out è registrato. Com’è andata?' }),
    switchRow('Ospiti senza problemi: si può chiedere la recensione', { checked: false, onChange: (v) => { review = v; } }));
  const dlg = openDialog({
    title: 'Chiudi il soggiorno',
    content: choice,
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Chiudi il soggiorno', onClick: save }),
    ],
  });
  async function save() {
    const cur = latest(ctx, b.id);
    try {
      await ctx.act('booking.close', { id: b.id, version: cur.version, review_ok: review === true }, {
        message: 'Soggiorno chiuso',
        undo: (res) => ctx.act('booking.step_back', { id: b.id, version: res.record.version }, { message: 'Soggiorno riaperto' }),
      });
      dlg.close();
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
}

export async function cancelBooking(ctx, b) {
  const ok = await confirmDialog({
    title: 'Cancellare la prenotazione?',
    text: `La prenotazione di ${b.guest_name} verrà segnata come cancellata e le date torneranno libere. Potrai ripristinarla se le date sono ancora libere.`,
    okLabel: 'Cancella prenotazione', danger: true,
  });
  if (!ok) return;
  const cur = latest(ctx, b.id);
  await ctx.act('booking.cancel', { id: b.id, version: cur.version }, {
    message: 'Prenotazione cancellata',
    undo: (res) => ctx.act('booking.restore', { id: b.id, version: res.record.version }, { message: 'Prenotazione ripristinata' }),
  }).catch(() => {});
}

export async function restoreBooking(ctx, b) {
  const cur = latest(ctx, b.id);
  await ctx.act('booking.restore', { id: b.id, version: cur.version }, { message: 'Prenotazione ripristinata' }).catch(() => {});
}
