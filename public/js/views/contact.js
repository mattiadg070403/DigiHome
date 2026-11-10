// Messaggi pronti per gli ospiti (WhatsApp) e azioni sugli avvisi "manca qualcosa".

import { h, icon } from '../dom.js';
import { fmtShort } from '../../shared/dates.js';
import { parseSteps } from '../../shared/booking.js';
import { fmtEuro } from '../../shared/money.js';
import { openBookingForm } from './form.js';
import { arrivalDialog, cancelBooking, restoreBooking, runNextAction } from './actions.js';

function guestName(b) {
  return String(b.guest_name || '').replace(/\s*\(prova\)$/, '').trim();
}

function myName(ctx) {
  return String(ctx.store.data.me?.name || '').replace(/\s*\(prova\)$/, '').split(/\s+/)[0] || '';
}

/** Numero per wa.me (solo cifre, con prefisso internazionale; senza prefisso si assume l'Italia). */
export function waNumber(phone) {
  let n = String(phone || '').replace(/[^\d+]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  else if (n.startsWith('00')) n = n.slice(2);
  else if (n.length === 10 && n.startsWith('3')) n = `39${n}`;
  return n.length >= 8 ? n : null;
}

export function waLink(phone, text) {
  const n = waNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

/** Testi dei messaggi. */
export function message(ctx, kind, b) {
  const house = ctx.store.data.houses.find((x) => x.id === b.house_id);
  const me = myName(ctx);
  const hello = `Ciao ${guestName(b)}${me ? `, sono ${me}` : ''} di ${house ? house.name : 'casa'}.`;
  const period = `dal ${fmtShort(b.check_in)} al ${fmtShort(b.check_out)}`;
  switch (kind) {
    case 'arrival':
      return `${hello} A che ora pensate di arrivare ${fmtShort(b.check_in)}? Così ci organizziamo per l’accoglienza. Il check-in è dalle ${house?.checkin_time || '14:00'}. Grazie!`;
    case 'deposit':
      return `${hello} Ti ricordo l’acconto di ${fmtEuro(b.deposit_cents)} per il soggiorno ${period}. Quando hai fatto il bonifico mandami pure la ricevuta qui. Grazie!`;
    case 'minors':
      return `${hello} Per i minorenni che non viaggiano con un genitore serve una delega firmata da un genitore, con la copia del suo documento. Me la puoi mandare prima dell’arrivo? Grazie!`;
    default:
      return hello;
  }
}

/** Pulsanti per un avviso. Restituisce un elemento o null. */
export function alertActions(ctx, b, alert) {
  const latest = () => ctx.store.data.bookings.find((x) => x.id === b.id) || b;
  const ask = (kind) => {
    const link = waLink(b.phone, message(ctx, kind, b));
    return link
      ? h('a', { class: 'btn small', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('chat', { size: 16 }), 'Chiedi su WhatsApp')
      : h('button', { class: 'btn small', type: 'button', onClick: () => openBookingForm(ctx, { existing: latest(), focus: 'phone' }) }, 'Aggiungi il telefono per scrivergli');
  };
  const update = (label, changes, done, undoChanges) => h('button', { class: 'btn small', type: 'button', onClick: () => {
    const cur = latest();
    ctx.act('booking.update', { id: b.id, version: cur.version, changes }, {
      message: done,
      undo: (r) => ctx.act('booking.update', { id: b.id, version: r.record.version, changes: undoChanges }),
    }).catch(() => {});
  } }, icon('check', { size: 16 }), label);
  const edit = (label, focus) => h('button', { class: 'btn small', type: 'button', onClick: () => openBookingForm(ctx, { existing: latest(), focus }) }, icon('edit', { size: 16 }), label);
  const next = (label, action) => h('button', { class: 'btn small house', type: 'button', text: label, onClick: () => runNextAction(ctx, latest(), action) });

  const ack = (label, done) => h('button', { class: 'btn small', type: 'button', onClick: () => {
    ctx.act('booking.ext_ack', { id: b.id, version: latest().version }, { message: done }).catch(() => {});
  } }, icon('check', { size: 16 }), label);

  let buttons = [];
  switch (alert.key) {
    case 'arrival': buttons = [ask('arrival'), h('button', { class: 'btn small', type: 'button', onClick: () => arrivalDialog(ctx, latest()) }, icon('edit', { size: 16 }), 'Inserisci l’orario')]; break;
    case 'deposit': buttons = [ask('deposit'), update('Segna acconto ricevuto', { deposit_paid: true }, 'Acconto segnato come ricevuto', { deposit_paid: false })]; break;
    case 'minors': buttons = [ask('minors'), update('Segna delega ricevuta', { minors_delegation: 'ricevuta' }, 'Delega segnata come ricevuta', { minors_delegation: 'da_chiedere' })]; break;
    case 'phone': buttons = [edit('Aggiungi il telefono', 'phone')]; break;
    case 'total': buttons = [edit('Inserisci il prezzo', 'total_cents')]; break;
    case 'overlap': buttons = [edit('Cambia le date', null)]; break;
    case 'checkin': buttons = [next(Object.values(parseSteps(latest().checkin_steps)).some(Boolean) || latest().stage === 'in_casa' ? 'Completa il check-in' : 'Inizia check-in', 'checkin')]; break;
    case 'checkout': buttons = [next('Inizia check-out', 'checkout')]; break;
    case 'close': buttons = [next('Chiudi il soggiorno', 'close')]; break;
    case 'details': buttons = [edit('Completa i dati', 'guest_name')]; break;
    case 'extras': buttons = [h('button', { class: 'btn small', type: 'button', onClick: () => {
      const unpaid = ctx.store.data.extras.filter((x) => x.booking_id === b.id && !x.deleted && !x.paid);
      for (const x of unpaid) {
        ctx.act('extra.update', { id: x.id, version: x.version, changes: { paid: 1 } }, {
          optimistic: (d) => ({ ...d, extras: d.extras.map((e) => (e.id === x.id ? { ...e, paid: 1 } : e)) }),
        }).catch(() => {});
      }
      ctx.toast(unpaid.length === 1 ? 'Extra segnato come incassato' : 'Extra segnati come incassati');
    } }, icon('check', { size: 16 }), 'Segna incassati')]; break;
    case 'ext_gone': buttons = [
      h('button', { class: 'btn small', type: 'button', text: 'Sì, è cancellata', onClick: () => cancelBooking(ctx, latest()) }),
      ack('No, è ancora valida', 'Segnata come ancora valida')]; break;
    case 'manual_cancel': buttons = [ack(`Fatto, cancellata anche su ${b.channel === 'airbnb' ? 'Airbnb' : 'Booking'}`, 'Avviso tolto'),
      ack('Non era una prenotazione vera', 'Avviso tolto'),
      h('button', { class: 'btn small', type: 'button', text: 'Ripristina', onClick: () => restoreBooking(ctx, latest()) })]; break;
    case 'ext_cancelled': buttons = [ack('Ok, visto', 'Avviso tolto'),
      h('button', { class: 'btn small', type: 'button', text: 'Ripristina', onClick: () => restoreBooking(ctx, latest()) })]; break;
    default: return null;
  }
  return h('div', { class: 'alert-actions' }, buttons);
}
