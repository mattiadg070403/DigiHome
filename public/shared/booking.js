// Regole delle prenotazioni: fasi, prossimo passo, avvisi, validazione.
// Usato sia dall'app sia dal server, così le regole sono scritte una volta sola.

import { addDays, daysBetween, fmtShort, isIsoDate, isTime, overlaps } from './dates.js';
import { taxSettings, touristTax } from './tax.js';
import { fmtEuro } from './money.js';

export const CHANNELS = {
  diretto: { label: 'Diretto', short: 'D' },
  airbnb: { label: 'Airbnb', short: 'A' },
  booking: { label: 'Booking', short: 'B' },
};

export const STAGES = ['confermata', 'in_casa', 'partita', 'chiusa', 'cancellata'];

export const SECURITY_STATUS = {
  nessuna: 'Nessuna cauzione',
  da_incassare: 'Da incassare',
  incassata: 'Incassata',
  restituita: 'Restituita',
  trattenuta: 'Trattenuta',
};

export const MINORS = {
  non_serve: 'Non serve',
  da_chiedere: 'Da chiedere',
  ricevuta: 'Ricevuta',
};

/** Passaggi del check-in. `required`: senza questo non si conclude. */
/* ---------- Extra (soldi a parte: tassa di soggiorno, supplementi) ---------- */

export const EXTRA_KINDS = { tassa_soggiorno: 'Tassa di soggiorno', altro: 'Altro' };

/** Nome da mostrare per un extra. */
export function extraLabel(x) {
  if (x.kind === 'altro') return x.label || 'Extra';
  if (x.kind === 'tassa_soggiorno') {
    if (x.amount_cents === 0) return 'Tassa di soggiorno (esenti)';
    return `Tassa di soggiorno${Number.isInteger(x.persons) ? ` (${x.persons} ${x.persons === 1 ? 'persona' : 'persone'})` : ''}`;
  }
  return EXTRA_KINDS[x.kind] || 'Extra';
}

/** Etichetta salvata quando l'importo della tassa è stato scritto a mano (non si ricontrolla). */
export const TAX_MANUAL = 'importo a mano';

/** Extra (non eliminati) di una prenotazione. */
export function extrasOf(b, extras = []) {
  return extras.filter((x) => x.booking_id === b.id && !x.deleted);
}

/** Somma degli extra; con unpaid = true solo quelli ancora da incassare. */
export function extrasTotal(list, { unpaid = false } = {}) {
  return list.reduce((n, x) => n + (unpaid && x.paid ? 0 : x.amount_cents), 0);
}

/**
 * Passaggi del check-in. opt.extras: extra della prenotazione (solo per i testi d'aiuto).
 * Il contratto serve solo per le prenotazioni dirette: con Airbnb e Booking valgono le loro condizioni.
 */
export function checkinSteps(b, opt = {}) {
  const steps = [
    {
      key: 'preparazione', required: false, title: 'Casa pronta per l’arrivo',
      help: 'Controlla i promemoria qui sotto prima che arrivino gli ospiti.', reminders: true,
    },
    {
      key: 'ospiti', required: true, title: 'Conta gli ospiti',
      help: `Prenotati ${b.guests}. Controlla che siano ${b.guests} persone; se sono di più, modifica la prenotazione.`,
    },
    {
      key: 'documenti', required: true, title: 'Documenti di tutti gli ospiti',
      help: `Servono ${b.guests} documenti validi. Ti servono per le schedine Alloggiati.`,
    },
  ];
  if (b.minors_delegation !== 'non_serve') {
    steps.push({
      key: 'minori', required: true, title: 'Delega per i minorenni',
      help: 'Se ci sono minorenni senza genitori, serve la delega firmata con il documento del genitore.',
    });
  }
  steps.push({ key: 'pagamenti', required: true, title: paymentTitle(b, opt.extras), help: paymentHelp(b, opt.extras) });
  if (b.channel === 'diretto') {
    steps.push({
      key: 'contratto', required: true, title: 'Contratto firmato',
      help: 'Fai firmare il contratto al capogruppo.',
    });
  }
  steps.push({
    key: 'contatori', required: false, title: 'Lettura dei contatori',
    help: 'Annota luce e gas, utile per conoscere i consumi del soggiorno.',
  });
  steps.push({
    key: 'alloggiati', required: true, title: 'Schedine Alloggiati inviate',
    help: 'Obbligatorie: invio sul portale Alloggiati Web della Polizia entro 24 ore dall’arrivo.',
  });
  steps.push({
    key: 'dms', required: true, title: 'Comunicazione DMS Puglia',
    help: 'Obbligatoria: registra l’arrivo degli ospiti sul portale DMS della Regione Puglia.',
  });
  return steps;
}

export function checkoutSteps(b) {
  return [
    { key: 'controllo', required: true, title: 'Controllo della casa', help: 'Giro di tutte le stanze, balconi compresi: danni, oggetti mancanti, pulizia generale.' },
    { key: 'chiavi', required: true, title: 'Chiavi riconsegnate', help: 'Tutte le copie, comprese quelle del garage se usato.' },
    { key: 'contatori', required: false, title: 'Lettura dei contatori', help: 'Annota luce e gas a fine soggiorno.' },
    { key: 'cauzione', required: b.security_cents > 0, title: 'Cauzione', help: 'Scegli se restituirla tutta o trattenerne una parte, con il motivo.' },
    { key: 'pulizie', required: false, title: 'Pulizie e lavanderia', help: 'Avvisa chi fa le pulizie e porta la biancheria in lavanderia.' },
  ];
}

function paymentTitle(b, extras = []) {
  if (b.channel === 'diretto') return 'Saldo e cauzione';
  return extras.length ? 'Extra e cauzione' : 'Cauzione';
}

function paymentHelp(b, extras = []) {
  const parts = [];
  if (b.channel === 'diretto') {
    const due = balanceDue(b);
    parts.push(due > 0 ? `${b.deposit_paid ? 'Saldo' : 'Totale (acconto non ricevuto)'} da incassare: ${fmtEuro(due)}.` : 'Saldo già pagato.');
  } else {
    parts.push(`Il soggiorno è pagato tramite ${CHANNELS[b.channel].label}.`);
  }
  const unpaid = extras.filter((x) => !x.paid);
  if (unpaid.length) parts.push(`Extra da incassare: ${unpaid.map((x) => `${extraLabel(x).toLowerCase()} ${fmtEuro(x.amount_cents)}`).join(', ')} (segnali come incassati nella scheda).`);
  if (b.security_cents > 0) parts.push(`Cauzione: ${fmtEuro(b.security_cents)}.`);
  return parts.join(' ');
}

/** Saldo ancora da incassare all'arrivo (solo prenotazioni dirette). */
export function balanceDue(b) {
  if (b.channel !== 'diretto') return 0;
  const paid = b.deposit_paid ? b.deposit_cents : 0;
  return Math.max(0, b.total_cents - paid);
}

export function parseSteps(json) {
  if (json && typeof json === 'object') return json;
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function missingRequired(steps, done) {
  return steps.filter((s) => s.required && !done[s.key]);
}

/* ---------- Scadenza del check-in (24 ore dall'arrivo) ---------- */

/** Orario di arrivo usato per i conteggi: quello previsto, altrimenti l'inizio del check-in della casa. */
export function arrivalTime(b, house = {}) {
  return b.arrival_time || house.checkin_time || '14:00';
}

/** Entro quando va concluso il check-in: 24 ore dopo l'arrivo. { date, time } */
export function checkinDeadline(b, house = {}) {
  return { date: addDays(b.check_in, 1), time: arrivalTime(b, house) };
}

/**
 * Il check-in è oltre le 24 ore dall'arrivo e non è concluso?
 * `time` è l'ora attuale 'HH:MM'; se manca si guarda solo la data.
 */
export function checkinOverdue(b, today, { time, house } = {}) {
  if (!isCheckinOpen(b, today)) return false;
  const dl = checkinDeadline(b, house);
  if (today > dl.date) return true;
  return today === dl.date && Boolean(time) && time >= dl.time;
}

/** Check-in iniziato o dovuto e non ancora concluso (oppure concluso con passaggi obbligatori mancanti). */
function isCheckinOpen(b, today) {
  if (b.stage === 'confermata') return b.check_in <= today;
  if (b.stage === 'in_casa') return checkinMissing(b).length > 0;
  return false;
}

/** Passaggi obbligatori del check-in ancora da fare. */
export function checkinMissing(b) {
  return missingRequired(checkinSteps(b), parseSteps(b.checkin_steps));
}

/** Nome breve di un passaggio, per frasi come "mancano documenti, DMS Puglia". */
export function stepLabel(s) {
  return STEP_SHORT[s.key] || s.title.toLowerCase();
}

function missingText(list) {
  const names = list.map(stepLabel);
  return names.length ? `mancano ${names.join(', ')}` : 'manca solo la conferma finale';
}

const STEP_SHORT = {
  ospiti: 'conta ospiti', documenti: 'documenti', minori: 'delega minorenni', pagamenti: 'pagamenti',
  contratto: 'contratto', alloggiati: 'schedine Alloggiati', dms: 'DMS Puglia',
};

function deadlineText(b, house) {
  const dl = checkinDeadline(b, house);
  return `${fmtShort(dl.date)} alle ${dl.time}`;
}

/**
 * Etichetta della fase, calcolata da fase salvata, date e ora.
 * opt: { time: 'HH:MM', house } (servono per la scadenza delle 24 ore).
 */
export function phase(b, today, opt = {}) {
  if (b.stage === 'cancellata') return { key: 'cancellata', label: 'Cancellata' };
  if (b.stage === 'chiusa') return { key: 'chiusa', label: 'Chiusa' };
  if (b.stage === 'partita') return { key: 'partita', label: 'Da chiudere' };
  if (b.stage === 'in_casa') {
    if (checkinMissing(b).length) return { key: 'checkin_ritardo', label: 'Check-in incompleto' };
    if (b.check_out === today) return { key: 'parte_oggi', label: 'Parte oggi' };
    if (b.check_out < today) return { key: 'checkout_mancante', label: 'Check-out da registrare' };
    return { key: 'in_casa', label: 'In casa' };
  }
  const d = daysBetween(today, b.check_in);
  if (d <= 0) {
    if (checkinOverdue(b, today, opt)) return { key: 'checkin_ritardo', label: 'Check-in in ritardo' };
    const started = Object.values(parseSteps(b.checkin_steps)).some(Boolean);
    if (d < 0 || started) return { key: 'checkin_corso', label: 'Check-in in corso' };
    return { key: 'arriva_oggi', label: 'Arriva oggi' };
  }
  if (d === 1) return { key: 'in_arrivo', label: 'Arriva domani' };
  if (d <= 7) return { key: 'in_arrivo', label: `Arriva tra ${d} giorni` };
  return { key: 'confermata', label: 'Confermata' };
}

/** Il prossimo passo da fare, con l'azione del pulsante principale (o null). `time`: ora attuale 'HH:MM'. */
export function nextStep(b, today, houseTimes = {}, time) {
  const outTime = houseTimes.checkout_time || '10:00';
  const inTime = houseTimes.checkin_time || '14:00';
  if (b.stage === 'cancellata') return { text: 'Prenotazione cancellata', action: null };
  if (b.stage === 'chiusa') return { text: 'Soggiorno chiuso', action: null };
  if (b.stage === 'partita') return { text: 'Ospiti partiti: chiudi il soggiorno', action: 'close', label: 'Chiudi il soggiorno' };
  if (b.stage === 'in_casa') {
    const missing = checkinMissing(b);
    if (missing.length) return { text: `Check-in incompleto: ${missingText(missing)}`, action: 'checkin', label: 'Completa il check-in', urgent: true };
    if (b.check_out <= today) return { text: `Check-out ${b.check_out === today ? 'oggi' : 'da registrare'} entro le ${outTime}`, action: 'checkout', label: 'Inizia check-out' };
    return { text: `Check-out ${fmtShort(b.check_out)} entro le ${outTime}`, action: 'checkout', label: 'Prepara check-out' };
  }
  const d = daysBetween(today, b.check_in);
  if (d <= 0) {
    const missing = checkinMissing(b);
    const started = Object.values(parseSteps(b.checkin_steps)).some(Boolean);
    if (checkinOverdue(b, today, { time, house: houseTimes })) {
      return { text: `Check-in non concluso da oltre 24 ore: ${missingText(missing)}`, action: 'checkin', label: 'Completa il check-in', urgent: true };
    }
    if (d < 0 || started) {
      return { text: `Concludi il check-in entro ${deadlineText(b, houseTimes)}: ${missingText(missing)}`, action: 'checkin', label: 'Continua il check-in' };
    }
    return { text: `Check-in dalle ${inTime}${b.arrival_time ? ` · arrivo previsto alle ${b.arrival_time}` : ''}`, action: 'checkin', label: 'Inizia check-in' };
  }
  if (d <= 3 && !b.arrival_time) return { text: `Arrivo ${fmtShort(b.check_in)}: chiedi l’orario`, action: 'arrival', label: 'Segna orario di arrivo' };
  return { text: `Arrivo ${fmtShort(b.check_in)}${b.arrival_time ? ` alle ${b.arrival_time}` : ''}`, action: null };
}

/** "3 persone", "1 persona", oppure "ospiti da completare" per le prenotazioni arrivate dal calendario. */
export function guestsLabel(b) {
  if (b.needs_details) return 'ospiti da completare';
  return `${b.guests} ${b.guests === 1 ? 'persona' : 'persone'}`;
}

/** Etichette di stato brevi per le schede. tone: ok | warn | neutral */
export function statusTags(b, today) {
  const tags = [];
  if (b.stage === 'cancellata') {
    if (b.ext_cancel_warn) return [{ text: `Ancora attiva su ${CHANNELS[b.channel]?.label || 'piattaforma'}`, tone: 'warn' }];
    return [{ text: b.ext_gone ? 'Cancellata in automatico' : 'Cancellata', tone: 'neutral' }];
  }
  if (b.needs_details) tags.push({ text: 'Dati da completare', tone: 'warn' });
  if (b.channel === 'diretto') {
    if (b.stage === 'confermata') {
      if (b.deposit_cents > 0) tags.push(b.deposit_paid ? { text: 'Acconto ricevuto', tone: 'ok' } : { text: 'Acconto non ricevuto', tone: 'warn' });
      const due = balanceDue(b);
      if (due > 0) tags.push({ text: `${b.deposit_paid ? 'Saldo all’arrivo' : 'Ancora da incassare'}: ${fmtEuro(due)}`, tone: 'neutral' });
    } else {
      tags.push({ text: 'Saldato', tone: 'ok' });
    }
  } else {
    tags.push({ text: `Pagato su ${CHANNELS[b.channel].label}`, tone: 'neutral' });
  }
  if (b.stage === 'in_casa' || (b.stage === 'confermata' && b.check_in <= today)) {
    const done = parseSteps(b.checkin_steps);
    if (b.stage === 'in_casa' || done.alloggiati || done.dms) {
      tags.push(done.alloggiati ? { text: 'Alloggiati inviate', tone: 'ok' } : { text: 'Alloggiati da inviare', tone: 'warn' });
      tags.push(done.dms ? { text: 'DMS Puglia fatto', tone: 'ok' } : { text: 'DMS Puglia da fare', tone: 'warn' });
    }
  }
  if (b.security_cents > 0) {
    const tone = b.security_status === 'da_incassare' && b.stage !== 'confermata' ? 'warn' : 'neutral';
    tags.push({ text: `Cauzione ${fmtEuro(b.security_cents)}: ${SECURITY_STATUS[b.security_status].toLowerCase()}`, tone });
  }
  if (b.minors_delegation === 'da_chiedere') tags.push({ text: 'Delega minorenni da chiedere', tone: 'warn' });
  return tags;
}

/**
 * Avvisi: cosa manca o va fatto. level: urgente | attenzione | info
 * `all` serve a controllare le sovrapposizioni; opt: { time: 'HH:MM', house } per la scadenza delle 24 ore.
 */
export function bookingAlerts(b, today, all = [], opt = {}) {
  const out = [];
  const add = (level, text, key) => out.push({ level, text, key, bookingId: b.id, houseId: b.house_id });
  const from = CHANNELS[b.channel]?.label || '';
  // Cancellata in automatico perché non è più nel calendario della piattaforma: avviso finché non si segna "visto".
  if (b.stage === 'cancellata' && b.ext_gone && b.check_out >= today) {
    add('attenzione', `Cancellata in automatico: non è più nel calendario ${from} (${fmtShort(b.check_in)} → ${fmtShort(b.check_out)})`, 'ext_cancelled');
    return out;
  }
  // Cancellata a mano nel gestionale: sulla piattaforma è ancora attiva finché non la cancelli anche lì.
  if (b.stage === 'cancellata' && b.ext_cancel_warn && b.check_out >= today) {
    add('urgente', `Cancellata solo nel gestionale: su ${from} la prenotazione (${fmtShort(b.check_in)} → ${fmtShort(b.check_out)}) risulta ancora attiva. `
      + `Se l'ospite ha cancellato, cancellala anche su ${from}; se è stato un errore, ripristinala. `
      + 'Finché non lo confermi, le date restano bloccate sull’altra piattaforma.', 'manual_cancel');
    return out;
  }
  if (b.stage === 'cancellata' || b.stage === 'chiusa') return out;
  const d = daysBetween(today, b.check_in);
  if (b.stage === 'confermata' && b.ext_gone) add('urgente', `Non risulta più nel calendario ${from}: controlla se è stata cancellata`, 'ext_gone');
  if (b.needs_details && b.stage !== 'partita') {
    add(d <= 3 ? 'urgente' : 'attenzione', `Arrivata dal calendario ${from}: completa nome, numero di ospiti e telefono`, 'details');
  }

  const clash = all.find((o) => o.id !== b.id && o.house_id === b.house_id && o.stage !== 'cancellata'
    && overlaps(b.check_in, b.check_out, o.check_in, o.check_out));
  if (clash) add('urgente', `Date sovrapposte con ${clash.guest_name} (${fmtShort(clash.check_in)} → ${fmtShort(clash.check_out)})`, 'overlap');

  if (b.stage === 'confermata' || b.stage === 'in_casa') {
    const missing = checkinMissing(b);
    const started = Object.values(parseSteps(b.checkin_steps)).some(Boolean);
    if (checkinOverdue(b, today, opt)) {
      add('urgente', `Check-in non concluso da oltre 24 ore dall’arrivo: ${missingText(missing)}`, 'checkin');
    } else if (b.stage === 'in_casa' && missing.length) {
      add('urgente', `Check-in incompleto: ${missingText(missing)} (entro ${deadlineText(b, opt.house)})`, 'checkin');
    } else if (b.stage === 'confermata' && (d < 0 || (d === 0 && started))) {
      add('attenzione', `Check-in da concludere entro ${deadlineText(b, opt.house)}: ${missingText(missing)}`, 'checkin');
    }
  }
  if (b.stage === 'confermata') {
    if (b.channel === 'diretto' && b.deposit_cents > 0 && !b.deposit_paid && d <= 14) add('attenzione', 'Acconto non ancora ricevuto', 'deposit');
    if (b.channel === 'diretto' && b.total_cents === 0) add('attenzione', 'Manca il prezzo totale', 'total');
    if (d >= 0 && d <= 3 && !b.arrival_time) add('attenzione', 'Manca l’orario di arrivo', 'arrival');
    if (d <= 7 && !b.phone && !b.needs_details) add('attenzione', 'Manca il numero di telefono', 'phone');
    if (d <= 7 && b.minors_delegation === 'da_chiedere') add('attenzione', 'Delega per i minorenni da chiedere', 'minors');
  }
  // Tassa di soggiorno: non inserita, oppure da ricontrollare perché date o persone sono cambiate.
  if (!b.needs_details && (b.stage === 'in_casa' || b.stage === 'partita' || (b.stage === 'confermata' && d <= 7))) {
    const settings = taxSettings(opt.house);
    const tax = (opt.extras || []).find((x) => x.kind === 'tassa_soggiorno');
    if (!tax) {
      const expected = touristTax(b.check_in, b.check_out, b.guests, settings).amount;
      if (expected > 0) add('attenzione', `Tassa di soggiorno non inserita (con ${b.guests} ${b.guests === 1 ? 'persona' : 'persone'}: ${fmtEuro(expected)})`, 'tax');
    } else if (!tax.paid && tax.label !== TAX_MANUAL && Number.isInteger(tax.persons)) {
      const expected = touristTax(b.check_in, b.check_out, tax.persons, settings).amount;
      if (expected !== tax.amount_cents) add('attenzione', `Tassa di soggiorno da ricontrollare: con le date attuali è ${fmtEuro(expected)}, salvata ${fmtEuro(tax.amount_cents)}`, 'tax');
    }
  }
  // Extra non ancora incassati quando l'ospite è già arrivato o partito.
  const unpaidExtras = (opt.extras || []).filter((x) => !x.paid);
  if (unpaidExtras.length && (b.stage === 'in_casa' || b.stage === 'partita' || (b.stage === 'confermata' && d <= 0))) {
    add(b.stage === 'partita' ? 'urgente' : 'attenzione',
      `Extra da incassare: ${unpaidExtras.map((x) => `${extraLabel(x).toLowerCase()} ${fmtEuro(x.amount_cents)}`).join(', ')}`, 'extras');
  }
  if (b.stage === 'in_casa' && b.check_out < today) add('urgente', 'Check-out non registrato', 'checkout');
  if (b.stage === 'partita') add(b.check_out < addDays(today, -2) ? 'attenzione' : 'info', 'Soggiorno da chiudere: segna se chiedere la recensione', 'close');
  return out;
}

export function taskAlerts(tasks, today) {
  return tasks
    .filter((t) => !t.deleted && !t.done && t.due_date && t.due_date < today)
    .map((t) => ({ level: 'attenzione', text: `Scaduto: ${t.title}`, taskId: t.id, houseId: t.house_id }));
}

export const LEVEL_ORDER = { urgente: 0, attenzione: 1, info: 2 };

/** Soggiorno in corso o il prossimo, per una casa. */
export function currentAndNext(bookings, houseId, today) {
  const list = bookings
    .filter((b) => b.house_id === houseId && b.stage !== 'cancellata' && b.stage !== 'chiusa')
    .sort((a, b) => (a.check_in < b.check_in ? -1 : a.check_in > b.check_in ? 1 : 0));
  // In corso: chi è in casa, chi doveva arrivare e non ha ancora fatto il check-in,
  // oppure chi è partito oggi (se nessuno arriva). I soggiorni passati da chiudere vanno negli avvisi.
  const current = list.find((b) => b.stage === 'in_casa')
    || list.find((b) => b.stage === 'confermata' && b.check_in <= today)
    || list.find((b) => b.stage === 'partita' && b.check_out === today);
  const next = list.find((b) => b !== current && b.stage === 'confermata' && b.check_in >= today);
  return { current: current || null, next: next || null };
}

/* ---------- Validazione (uguale su app e server) ---------- */

const TEXT_FIELDS = { guest_name: 120, phone: 40, email: 160, notes: 2000, security_note: 300, arrival_time: 5 };

/**
 * Controlla e ripulisce i campi di una prenotazione.
 * Restituisce { ok, value, errors } dove errors è { campo: messaggio }.
 */
export function validateBooking(input, { house, partial = false } = {}) {
  const errors = {};
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const need = (k) => !partial || has(k);

  if (need('channel')) {
    if (!CHANNELS[input.channel]) errors.channel = 'Scegli il canale';
    else v.channel = input.channel;
  }
  if (need('guest_name')) {
    const s = String(input.guest_name ?? '').trim();
    if (!s) errors.guest_name = 'Scrivi il nome dell’ospite';
    else if (s.length > TEXT_FIELDS.guest_name) errors.guest_name = 'Nome troppo lungo';
    else v.guest_name = s;
  }
  for (const k of ['phone', 'email', 'notes', 'security_note']) {
    if (has(k)) {
      const s = input[k] == null ? '' : String(input[k]).trim();
      if (s.length > TEXT_FIELDS[k]) errors[k] = 'Testo troppo lungo';
      else v[k] = s || null;
    }
  }
  if (has('phone') && v.phone && !/^[+()\d\s./-]{5,40}$/.test(v.phone)) errors.phone = 'Numero di telefono non valido';
  if (has('email') && v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = 'Email non valida';
  if (has('arrival_time')) {
    const s = input.arrival_time == null ? '' : String(input.arrival_time).trim();
    if (s && !isTime(s)) errors.arrival_time = 'Orario non valido (es. 16:30)';
    else v.arrival_time = s || null;
  }
  if (need('guests')) {
    const n = Number(input.guests);
    const max = house ? house.max_guests : 50;
    if (!Number.isInteger(n) || n < 1) errors.guests = 'Indica quante persone';
    else if (n > max) errors.guests = `Massimo ${max} persone in questa casa`;
    else v.guests = n;
  }
  if (need('check_in') || need('check_out')) {
    const a = has('check_in') ? input.check_in : undefined;
    const b = has('check_out') ? input.check_out : undefined;
    if (need('check_in') && !isIsoDate(a)) errors.check_in = 'Scegli la data di arrivo';
    if (need('check_out') && !isIsoDate(b)) errors.check_out = 'Scegli la data di partenza';
    if (isIsoDate(a)) v.check_in = a;
    if (isIsoDate(b)) v.check_out = b;
    if (isIsoDate(a) && isIsoDate(b)) {
      if (b <= a) errors.check_out = 'La partenza deve essere dopo l’arrivo';
      else if (daysBetween(a, b) > 90) errors.check_out = 'Soggiorno troppo lungo (massimo 90 notti)';
    }
  }
  for (const k of ['total_cents', 'deposit_cents', 'security_cents', 'security_withheld_cents']) {
    if (has(k)) {
      const n = Number(input[k]);
      if (!Number.isSafeInteger(n) || n < 0 || n > 100000000) errors[k] = 'Importo non valido';
      else v[k] = n;
    }
  }
  if (v.deposit_cents !== undefined && v.total_cents !== undefined && v.deposit_cents > v.total_cents) {
    errors.deposit_cents = 'L’acconto supera il totale';
  }
  for (const k of ['deposit_paid', 'linens', 'towels']) {
    if (has(k)) v[k] = input[k] ? 1 : 0;
  }
  if (has('minors_delegation')) {
    if (!MINORS[input.minors_delegation]) errors.minors_delegation = 'Valore non valido';
    else v.minors_delegation = input.minors_delegation;
  }
  if (has('security_status')) {
    if (!SECURITY_STATUS[input.security_status]) errors.security_status = 'Valore non valido';
    else v.security_status = input.security_status;
  }
  return { ok: Object.keys(errors).length === 0, value: v, errors };
}

/* ---------- Disponibilità (calendario) ---------- */

/** Notti occupate in una casa: insieme di date 'AAAA-MM-GG' (la notte tra quel giorno e il successivo). */
export function occupiedNights(bookings, houseId, excludeId = null) {
  const out = new Set();
  for (const b of bookings) {
    if (b.house_id !== houseId || b.stage === 'cancellata' || b.id === excludeId) continue;
    for (let d = b.check_in; d < b.check_out; d = addDays(d, 1)) out.add(d);
  }
  return out;
}

/** Tutte le notti da a (compreso) a b (escluso) sono libere? */
export function rangeFree(nightsSet, a, b) {
  for (let d = a; d < b; d = addDays(d, 1)) if (nightsSet.has(d)) return false;
  return true;
}

/** Primo giorno dopo `from` in cui inizia una notte occupata (oltre quel giorno non si può partire). */
export function nextBlocked(nightsSet, from, limitDays = 400) {
  for (let i = 0, d = from; i < limitDays; i++, d = addDays(d, 1)) if (nightsSet.has(d)) return d;
  return null;
}

/* ---------- Promemoria per l'arrivo ---------- */

/** Cose da preparare e da incassare per un arrivo, in parole semplici. */
/**
 * Promemoria per l'arrivo, in ordine di importanza. Ogni voce ha un livello:
 * 'money' = soldi da incassare (in evidenza), 'must' = cosa va fatto per forza, 'info' = da sapere.
 * Restituisce testi; arrivalReminderItems restituisce { level, text }.
 */
export function arrivalReminders(b, house = {}, extras = []) {
  return arrivalReminderItems(b, house, extras).map((x) => x.text);
}

export function arrivalReminderItems(b, house = {}, extras = []) {
  const items = [];
  const add = (level, text) => items.push({ level, text });
  // 1. Soldi
  const due = balanceDue(b);
  const money = [];
  if (due > 0) money.push(`${b.deposit_paid ? 'saldo' : 'totale'} ${fmtEuro(due)}`);
  for (const x of extras.filter((e) => !e.paid)) money.push(`${extraLabel(x).toLowerCase()} ${fmtEuro(x.amount_cents)}`);
  if (b.security_cents > 0 && b.security_status === 'da_incassare') money.push(`cauzione ${fmtEuro(b.security_cents)}`);
  const sum = due + extrasTotal(extras, { unpaid: true }) + (b.security_cents > 0 && b.security_status === 'da_incassare' ? b.security_cents : 0);
  if (money.length) add('money', `Da incassare all’arrivo: ${fmtEuro(sum)} (${money.join(' + ')})${b.channel !== 'diretto' ? ` · il soggiorno è già pagato su ${CHANNELS[b.channel].label}` : ''}`);
  else add('info', b.channel !== 'diretto' ? `Niente da incassare: soggiorno già pagato su ${CHANNELS[b.channel].label}` : 'Niente da incassare: tutto già pagato');
  // 2. Obblighi
  if (b.needs_details) add('must', 'Numero di ospiti ancora da completare: chiedilo prima di preparare la casa');
  if (b.minors_delegation === 'da_chiedere') add('must', 'Delega per i minorenni ancora da ricevere');
  if (b.minors_delegation === 'ricevuta') add('must', 'Delega per i minorenni ricevuta: controllala all’arrivo');
  add('must', `Entro 24 ore dall’arrivo (${deadlineText(b, house)}): schedine Alloggiati e comunicazione DMS Puglia`);
  if (b.channel === 'diretto') add('must', 'Far firmare il contratto al capogruppo');
  // 3. Preparazione e informazioni
  if (!b.needs_details) {
    add('info', b.linens ? `Lenzuola per ${b.guests} ${b.guests === 1 ? 'persona' : 'persone'}` : 'Lenzuola non incluse: non prepararle');
    add('info', b.towels ? `Asciugamani per ${b.guests} ${b.guests === 1 ? 'persona' : 'persone'}` : 'Asciugamani non inclusi');
  }
  add('info', b.arrival_time ? `Arrivo previsto alle ${b.arrival_time}` : `Orario di arrivo non ancora noto (check-in dalle ${house.checkin_time || '14:00'})`);
  if (b.notes) add('info', `Note: ${b.notes}`);
  return items;
}
