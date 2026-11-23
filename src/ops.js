// Tutte le modifiche ai dati passano da qui.
// Ogni operazione: controllo, scrittura, registro modifiche e contatore in un'unica transazione.

import { CHANNELS, balanceDue, checkinSteps, checkoutSteps, missingRequired, parseSteps, validateBooking } from '../public/shared/booking.js';
import { daysBetween, fmtShort, isIsoDate, isTime } from '../public/shared/dates.js';
import { checkCalendarUrl, maskCalendarUrl } from '../public/shared/calendar.js';
import { checkTaxSettings } from '../public/shared/tax.js';
import { validateExpense, validateDeadline, nextDue } from '../public/shared/house.js';
import { CONTRACT_TEMPLATE, LANGS, buildContract, checkGuest, checkSignature, contractMissing, hashInput, parseContractInfo,
  purgeDate, sha256Hex, checkContractInfo } from '../public/shared/contract.js';
import { todayRome } from '../public/shared/dates.js';
import { checkQuoteSettings } from '../public/shared/quote.js';
import { checkPricingSettings, checkWeekChanges } from '../public/shared/pricing.js';
import { meterCalc, meterExtraLabel } from '../public/shared/meter.js';
import { PAY_METHODS, checkAccountingSettings, checkRemittance } from '../public/shared/accounting.js';

export const REV_NEXT = "(SELECT value FROM meta WHERE key = 'rev') + 1";
const OVERLAP = `EXISTS (SELECT 1 FROM bookings o WHERE o.house_id = ? AND o.stage <> 'cancellata'
  AND o.id <> ? AND o.check_in < ? AND o.check_out > ?)`;

const BOOKING_EDITABLE = ['channel', 'guest_name', 'phone', 'email', 'guests', 'check_in', 'check_out', 'arrival_time',
  'total_cents', 'deposit_cents', 'deposit_paid', 'security_cents', 'linens', 'towels', 'minors_delegation', 'notes'];

export class OpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const bad = (message, extra) => new OpError(400, 'validation', message, extra);
const notFound = () => new OpError(404, 'not_found', 'Non trovato: forse è stato eliminato da un altro dispositivo.');
const forbidden = () => new OpError(403, 'forbidden', 'Solo l’amministratore può fare questa modifica.');

function nowIso() {
  return new Date().toISOString();
}

function isId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);
}

/**
 * Esegue in un'unica transazione: l'istruzione principale, l'aumento del contatore,
 * la riga del registro e la memoria dell'operazione.
 *
 * L'istruzione principale scrive rev = contatore + 1 sulla riga che modifica. Quel valore
 * non è mai stato usato prima (ogni riga ha rev <= contatore), quindi è un segno univoco
 * di questa operazione. Registro, memoria dell'operazione e aumento del contatore
 * avvengono solo se trovano il segno: se la principale non ha modificato nulla
 * (versione cambiata, date occupate, fase sbagliata, nessun cambiamento) non si scrive niente.
 * Il contatore si aumenta per ultimo, così il segno resta valido per tutte le istruzioni.
 * Restituisce true se la modifica è avvenuta.
 */
const TABLES = { booking: 'bookings', note: 'booking_notes', task: 'tasks', user: 'users', house: 'houses', calendar: 'calendars', extra: 'booking_extras', expense: 'expenses', deadline: 'deadlines', contract: 'contracts', remittance: 'remittances', guest: 'guests', price: 'price_lists', payreceipt: 'pay_receipts' };

export async function commit(db, { main, also = [], user, opId, entity, entityId, action, changes }) {
  const table = TABLES[entity];
  const at = nowIso();
  const marked = `EXISTS (SELECT 1 FROM ${table} WHERE id = ?
    AND rev = (SELECT value FROM meta WHERE key = 'rev') + 1)`;
  const stmts = [
    main,
    // Istruzioni collegate (es. spunta del passaggio del check-in): devono controllare da sole il segno.
    ...also,
    db.prepare(`INSERT INTO audit_log (at, user_email, entity, entity_id, action, changes)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${marked}`)
      .bind(at, user.email, entity, entityId, action, changes ? JSON.stringify(changes) : null, entityId),
    db.prepare(`INSERT INTO ops (op_id, at, user_email, result)
      SELECT ?, ?, ?, json_object('entity', ?, 'id', ?, 'rev', (SELECT value FROM meta WHERE key = 'rev') + 1)
      WHERE ${marked}`).bind(opId, at, user.email, entity, entityId, entityId),
    db.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'rev' AND ${marked}`).bind(entityId),
  ];
  const results = await db.batch(stmts);
  return results[results.length - 1].meta.changes === 1;
}

async function getBooking(db, id) {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
}

async function getHouse(db, id) {
  return db.prepare('SELECT * FROM houses WHERE id = ?').bind(id).first();
}

async function findClash(db, houseId, selfId, checkIn, checkOut) {
  return db.prepare(`SELECT id, guest_name, check_in, check_out FROM bookings
    WHERE house_id = ? AND stage <> 'cancellata' AND id <> ? AND check_in < ? AND check_out > ? LIMIT 1`)
    .bind(houseId, selfId, checkOut, checkIn).first();
}

function overlapError(clash) {
  return new OpError(409, 'overlap',
    `Date occupate: c’è già ${clash.guest_name} dal ${fmtShort(clash.check_in)} al ${fmtShort(clash.check_out)}.`,
    { clash });
}

function conflictError(current) {
  return new OpError(409, 'conflict',
    'Nel frattempo questa prenotazione è stata modificata da un altro dispositivo. Ricarica per vedere la versione aggiornata.',
    { current });
}

function diff(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    if (before[k] !== after[k]) out[k] = [before[k] ?? null, after[k] ?? null];
  }
  return out;
}

/** Dopo una scrittura non riuscita: capisce perché e lancia l'errore giusto. */
async function explainBookingFailure(db, id, version, dates) {
  const cur = await getBooking(db, id);
  if (!cur) throw notFound();
  if (version !== undefined && cur.version !== version) throw conflictError(cur);
  if (dates) {
    const clash = await findClash(db, cur.house_id, id, dates.check_in, dates.check_out);
    if (clash) throw overlapError(clash);
  }
  throw new OpError(409, 'state', 'Questa operazione non è possibile nella fase attuale della prenotazione.', { current: cur });
}

/* ------------------------------ Prenotazioni ------------------------------ */

async function bookingCreate(db, user, opId, p) {
  const b = p.booking || {};
  if (typeof b.house_id !== 'string') throw bad('Scegli la casa');
  const house = await getHouse(db, b.house_id);
  if (!house) throw bad('Casa non trovata');
  const { ok, value, errors } = validateBooking(b, { house });
  if (!ok) throw bad('Controlla i campi evidenziati', { errors });
  const id = isId(p.id) ? p.id : crypto.randomUUID();
  if (await getBooking(db, id)) throw new OpError(409, 'state', 'Prenotazione già salvata.');
  const at = nowIso();
  const row = {
    id, house_id: house.id,
    channel: value.channel, guest_name: value.guest_name, phone: value.phone ?? null, email: value.email ?? null,
    guests: value.guests, check_in: value.check_in, check_out: value.check_out, arrival_time: value.arrival_time ?? null,
    total_cents: value.total_cents ?? 0, deposit_cents: value.deposit_cents ?? 0, deposit_paid: value.deposit_paid ?? 0,
    security_cents: value.security_cents ?? 0,
    security_status: (value.security_cents ?? 0) > 0 ? 'da_incassare' : 'nessuna',
    linens: value.linens ?? 1, towels: value.towels ?? 0, minors_delegation: value.minors_delegation ?? 'non_serve',
    notes: value.notes ?? null,
    booked_on: todayRome(), // giorno in cui è arrivata (ritmo delle prenotazioni nel listino)
  };
  if (row.deposit_cents > row.total_cents) throw bad('L’acconto supera il totale', { errors: { deposit_cents: 'L’acconto supera il totale' } });
  const cols = Object.keys(row);
  const main = db.prepare(`INSERT INTO bookings (${cols.join(', ')}, created_at, created_by, updated_at, updated_by, rev)
    SELECT ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ${REV_NEXT}
    WHERE NOT ${OVERLAP}`)
    .bind(...cols.map((c) => row[c]), at, user.email, at, user.email,
      row.house_id, id, row.check_out, row.check_in);
  const done = await commit(db, { main, user, opId, entity: 'booking', entityId: id, action: 'create', changes: row });
  if (!done) {
    const clash = await findClash(db, row.house_id, id, row.check_in, row.check_out);
    if (clash) throw overlapError(clash);
    throw new OpError(409, 'state', 'Prenotazione non salvata. Riprova.');
  }
  return { record: await getBooking(db, id) };
}

async function bookingUpdate(db, user, opId, p) {
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await getBooking(db, p.id);
  if (!cur) throw notFound();
  if (cur.version !== p.version) throw conflictError(cur);
  if (cur.stage === 'cancellata' || cur.stage === 'chiusa') {
    throw new OpError(409, 'state', 'Una prenotazione cancellata o chiusa non si può modificare.');
  }
  const input = {};
  for (const k of Object.keys(p.changes || {})) {
    if (!BOOKING_EDITABLE.includes(k)) throw bad(`Campo non modificabile: ${k}`);
    input[k] = p.changes[k];
  }
  if (cur.ext_uid && 'channel' in input && input.channel !== cur.channel) {
    throw bad('Questa prenotazione arriva dal calendario: il canale non si può cambiare.');
  }
  const house = await getHouse(db, cur.house_id);
  const { ok, value, errors } = validateBooking(input, { house, partial: true });
  if (!ok) throw bad('Controlla i campi evidenziati', { errors });
  const merged = { ...cur, ...value };
  if (merged.check_out <= merged.check_in) throw bad('La partenza deve essere dopo l’arrivo', { errors: { check_out: 'La partenza deve essere dopo l’arrivo' } });
  if (daysBetween(merged.check_in, merged.check_out) > 90) throw bad('Soggiorno troppo lungo (massimo 90 notti)', { errors: { check_out: 'Soggiorno troppo lungo (massimo 90 notti)' } });
  if (merged.deposit_cents > merged.total_cents) throw bad('L’acconto supera il totale', { errors: { deposit_cents: 'L’acconto supera il totale' } });
  if (value.security_cents !== undefined && cur.security_status === 'nessuna' && value.security_cents > 0) value.security_status = 'da_incassare';
  if (value.security_cents === 0 && cur.security_status === 'da_incassare') value.security_status = 'nessuna';
  const changes = diff(cur, value);
  // Prenotazione arrivata dal calendario: salvarla dal modulo vuol dire che i dati sono stati completati.
  if (cur.needs_details) changes.needs_details = [1, 0];
  if (Object.keys(changes).length === 0) return { record: cur, unchanged: true };
  const cols = Object.keys(changes).filter((c) => c !== 'needs_details');
  const at = nowIso();
  const main = db.prepare(`UPDATE bookings SET ${cols.map((c) => `${c} = ?, `).join('')}needs_details = 0,
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND version = ? AND NOT ${OVERLAP}`)
    .bind(...cols.map((c) => value[c]), at, user.email, p.id, p.version,
      cur.house_id, p.id, merged.check_out, merged.check_in);
  const done = await commit(db, { main, user, opId, entity: 'booking', entityId: p.id, action: 'update', changes });
  if (!done) await explainBookingFailure(db, p.id, p.version, merged);
  return { record: await getBooking(db, p.id) };
}

async function bookingStep(db, user, opId, p) {
  if (!isId(p.id) || !['checkin', 'checkout'].includes(p.flow) || typeof p.step !== 'string') throw bad('Richiesta non valida');
  const cur = await getBooking(db, p.id);
  if (!cur) throw notFound();
  const steps = p.flow === 'checkin' ? checkinSteps(cur) : checkoutSteps(cur);
  if (!steps.some((s) => s.key === p.step)) throw bad('Passaggio non valido');
  const allowed = p.flow === 'checkin' ? ['confermata', 'in_casa'] : ['in_casa', 'partita'];
  if (!allowed.includes(cur.stage)) throw new OpError(409, 'state', 'Questo passaggio non si può cambiare nella fase attuale.');
  const col = p.flow === 'checkin' ? 'checkin_steps' : 'checkout_steps';
  const value = p.done ? 1 : 0;
  const main = db.prepare(`UPDATE bookings SET ${col} = json_set(${col}, ?, json(?)),
      rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND stage IN (${allowed.map(() => '?').join(', ')})`)
    .bind(`$.${p.step}`, String(value), nowIso(), user.email, p.id, ...allowed);
  const done = await commit(db, { main, user, opId, entity: 'booking', entityId: p.id, action: `${p.flow}_step`, changes: { [p.step]: value } });
  if (!done) await explainBookingFailure(db, p.id);
  return { record: await getBooking(db, p.id) };
}

async function setStage(db, user, opId, p, { from, to, action, extraSet = '', extraBind = [], check, changes = {} }) {
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await getBooking(db, p.id);
  if (!cur) throw notFound();
  if (cur.version !== p.version) throw conflictError(cur);
  if (!from.includes(cur.stage)) throw new OpError(409, 'state', 'Questa operazione non è possibile nella fase attuale della prenotazione.', { current: cur });
  if (check) check(cur);
  const target = typeof to === 'function' ? to(cur) : to;
  const needsOverlap = cur.stage === 'cancellata';
  const main = db.prepare(`UPDATE bookings SET stage = ?, prev_stage = ?${extraSet},
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND version = ? AND stage = ?${needsOverlap ? ` AND NOT ${OVERLAP}` : ''}`)
    .bind(target, cur.stage, ...extraBind, nowIso(), user.email, p.id, p.version, cur.stage,
      ...(needsOverlap ? [cur.house_id, p.id, cur.check_out, cur.check_in] : []));
  const done = await commit(db, { main, user, opId, entity: 'booking', entityId: p.id, action, changes: { stage: [cur.stage, target], ...changes } });
  if (!done) await explainBookingFailure(db, p.id, p.version, needsOverlap ? cur : null);
  return { record: await getBooking(db, p.id) };
}

function bookingCompleteCheckin(db, user, opId, p) {
  return setStage(db, user, opId, p, {
    from: ['confermata'], to: 'in_casa', action: 'checkin',
    extraSet: ", security_status = CASE WHEN security_cents > 0 AND security_status = 'da_incassare' THEN 'incassata' ELSE security_status END",
    check: (cur) => {
      const missing = missingRequired(checkinSteps(cur), parseSteps(cur.checkin_steps));
      if (missing.length) throw bad(`Mancano dei passaggi: ${missing.map((s) => s.title).join(', ')}.`);
    },
  });
}

async function bookingCompleteCheckout(db, user, opId, p) {
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await getBooking(db, p.id);
  if (!cur) throw notFound();
  const sec = p.security || {};
  let status = cur.security_status;
  let withheld = cur.security_withheld_cents;
  let note = cur.security_note;
  if (cur.security_cents > 0) {
    if (!['restituita', 'trattenuta'].includes(sec.status)) throw bad('Indica se la cauzione è stata restituita o trattenuta.');
    status = sec.status;
    withheld = 0;
    note = null;
    if (status === 'trattenuta') {
      withheld = Number(sec.withheld_cents);
      if (!Number.isSafeInteger(withheld) || withheld <= 0 || withheld > cur.security_cents) throw bad('Importo trattenuto non valido.');
      note = String(sec.note || '').trim();
      if (!note) throw bad('Scrivi il motivo della trattenuta.');
      if (note.length > 300) throw bad('Motivo troppo lungo.');
    }
  }
  return setStage(db, user, opId, p, {
    from: ['in_casa'], to: 'partita', action: 'checkout',
    extraSet: ', security_status = ?, security_withheld_cents = ?, security_note = ?',
    extraBind: [status, withheld, note],
    changes: { security_status: [cur.security_status, status], security_withheld_cents: [cur.security_withheld_cents, withheld] },
    check: (c) => {
      const missing = missingRequired(checkoutSteps(c), { ...parseSteps(c.checkout_steps), cauzione: true });
      if (missing.length) throw bad(`Mancano dei passaggi: ${missing.map((s) => s.title).join(', ')}.`);
    },
  });
}

function bookingClose(db, user, opId, p) {
  const review = p.review_ok === true ? 1 : p.review_ok === false ? 0 : null;
  return setStage(db, user, opId, p, {
    from: ['partita'], to: 'chiusa', action: 'close',
    extraSet: ', review_ok = ?', extraBind: [review], changes: { review_ok: [null, review] },
  });
}

function bookingCancel(db, user, opId, p) {
  // Prenotazione di Airbnb/Booking cancellata qui: sulla piattaforma resta attiva → avviso finché non si conferma.
  return setStage(db, user, opId, p, {
    from: ['confermata', 'in_casa', 'partita'], to: 'cancellata', action: 'cancel',
    extraSet: ", ext_cancel_warn = CASE WHEN channel <> 'diretto' AND ext_gone = 0 THEN 1 ELSE 0 END",
  });
}

function bookingRestore(db, user, opId, p) {
  // Se era stata cancellata in automatico dal calendario, ripristinarla a mano la stacca dal calendario:
  // da qui in poi la gestisci tu e l'aggiornamento automatico non la ricancella.
  return setStage(db, user, opId, p, {
    from: ['cancellata'], to: (cur) => cur.prev_stage || 'confermata', action: 'restore',
    extraSet: ', ext_uid = CASE WHEN ext_gone = 1 THEN NULL ELSE ext_uid END, ext_gone = 0, ext_cancel_warn = 0',
  });
}

/** "Visto": toglie l'avviso di una prenotazione sparita dal calendario (ancora valida, o cancellata in automatico). */
async function bookingExtAck(db, user, opId, p) {
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await getBooking(db, p.id);
  if (!cur) throw notFound();
  if (cur.version !== p.version) throw conflictError(cur);
  if (!cur.ext_gone && !cur.ext_cancel_warn) return { record: cur, unchanged: true };
  // Ancora valida anche se non è più nel calendario: si stacca dal calendario, così non viene ricancellata.
  const main = db.prepare(`UPDATE bookings SET ext_gone = 0, ext_cancel_warn = 0,
      ext_uid = CASE WHEN stage <> 'cancellata' AND ext_gone = 1 THEN NULL ELSE ext_uid END,
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND version = ?`).bind(nowIso(), user.email, p.id, p.version);
  const changes = cur.ext_gone ? { ext_gone: [1, 0] } : { ext_cancel_warn: [1, 0] };
  const done = await commit(db, { main, user, opId, entity: 'booking', entityId: p.id, action: 'ext_ack', changes });
  if (!done) await explainBookingFailure(db, p.id, p.version);
  return { record: await getBooking(db, p.id) };
}

/** Torna alla fase precedente (per "Annulla" dopo check-in, check-out o chiusura). */
function bookingStepBack(db, user, opId, p) {
  const back = { in_casa: 'confermata', partita: 'in_casa', chiusa: 'partita' };
  return setStage(db, user, opId, p, {
    from: Object.keys(back), to: (cur) => back[cur.stage], action: 'step_back',
    extraSet: ", security_status = CASE WHEN stage = 'partita' AND security_cents > 0 THEN 'incassata' WHEN stage = 'in_casa' AND security_cents > 0 THEN 'da_incassare' ELSE security_status END, security_withheld_cents = CASE WHEN stage = 'partita' THEN 0 ELSE security_withheld_cents END",
  });
}

/* --------------------------------- Note ---------------------------------- */

async function noteAdd(db, user, opId, p) {
  if (!isId(p.bookingId)) throw bad('Richiesta non valida');
  const text = String(p.text || '').trim();
  if (!text) throw bad('La nota è vuota');
  if (text.length > 1000) throw bad('Nota troppo lunga (massimo 1000 caratteri)');
  const b = await getBooking(db, p.bookingId);
  if (!b) throw notFound();
  const id = isId(p.id) ? p.id : crypto.randomUUID();
  const main = db.prepare(`INSERT INTO booking_notes (id, booking_id, text, created_at, created_by, rev)
    VALUES (?, ?, ?, ?, ?, ${REV_NEXT})`).bind(id, p.bookingId, text, nowIso(), user.email);
  await commit(db, { main, user, opId, entity: 'note', entityId: id, action: 'create', changes: { booking_id: p.bookingId, text } });
  return { record: await db.prepare('SELECT * FROM booking_notes WHERE id = ?').bind(id).first() };
}

async function noteSetDeleted(db, user, opId, p, deleted) {
  if (!isId(p.id)) throw bad('Richiesta non valida');
  const main = db.prepare(`UPDATE booking_notes SET deleted = ?, rev = ${REV_NEXT} WHERE id = ? AND deleted = ?`)
    .bind(deleted, p.id, deleted ? 0 : 1);
  const done = await commit(db, { main, user, opId, entity: 'note', entityId: p.id, action: deleted ? 'delete' : 'restore' });
  const record = await db.prepare('SELECT * FROM booking_notes WHERE id = ?').bind(p.id).first();
  if (!record) throw notFound();
  return { record, unchanged: !done };
}

/* ------------------------------- Extra ------------------------------- */

const EXTRA_KINDS = ['tassa_soggiorno', 'altro'];

function validateExtra(input, partial) {
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  if (!partial || has('kind')) {
    if (!EXTRA_KINDS.includes(input.kind)) throw bad('Scegli il tipo di extra');
    v.kind = input.kind;
  }
  if (!partial || has('label')) {
    const s = String(input.label ?? '').trim();
    if (s.length > 80) throw bad('Descrizione troppo lunga');
    v.label = s || null;
  }
  if (!partial || has('amount_cents')) {
    const n = Number(input.amount_cents);
    if (!Number.isSafeInteger(n) || n < 0 || n > 100000000) throw bad('Importo non valido', { errors: { amount_cents: 'Importo non valido' } });
    v.amount_cents = n;
  }
  if (has('persons')) {
    const p = input.persons === null || input.persons === '' ? null : Number(input.persons);
    if (p !== null && (!Number.isInteger(p) || p < 0 || p > 50)) throw bad('Numero di persone non valido');
    v.persons = p;
  }
  if (!partial || has('paid')) v.paid = input.paid ? 1 : 0;
  if (has('paid_method')) {
    if (input.paid_method !== null && !Object.hasOwn(PAY_METHODS, input.paid_method)) throw bad('Scegli bonifico o contanti');
    v.paid_method = input.paid_method || null;
  }
  return v;
}

/** Importo 0 solo per la tassa (tutti esenti); per gli altri extra serve un importo. */
function checkExtraAmount(kind, amount) {
  if (kind !== 'tassa_soggiorno' && amount < 1) throw bad('Scrivi l’importo', { errors: { amount_cents: 'Scrivi l’importo' } });
}

async function extraAdd(db, user, opId, p) {
  if (!isId(p.bookingId)) throw bad('Richiesta non valida');
  const b = await getBooking(db, p.bookingId);
  if (!b) throw notFound();
  if (b.stage === 'cancellata') throw new OpError(409, 'state', 'La prenotazione è cancellata.');
  const v = validateExtra(p.extra || {}, false);
  if (v.kind === 'altro' && !v.label) throw bad('Scrivi a cosa si riferisce', { errors: { label: 'Scrivi a cosa si riferisce' } });
  checkExtraAmount(v.kind, v.amount_cents);
  if (v.kind === 'tassa_soggiorno'
    && await db.prepare("SELECT 1 FROM booking_extras WHERE booking_id = ? AND kind = 'tassa_soggiorno' AND deleted = 0").bind(b.id).first()) {
    throw new OpError(409, 'state', 'La tassa di soggiorno di questa prenotazione c’è già: modificala.');
  }
  const id = isId(p.id) ? p.id : crypto.randomUUID();
  if (await db.prepare('SELECT 1 FROM booking_extras WHERE id = ?').bind(id).first()) throw new OpError(409, 'state', 'Extra già salvato.');
  const at = nowIso();
  // Tassa con importo 0 (tutti esenti): non c'è niente da incassare.
  const paid = v.amount_cents === 0 ? 1 : v.paid;
  const main = db.prepare(`INSERT INTO booking_extras (id, booking_id, kind, label, persons, amount_cents, paid, paid_at, created_at, created_by, updated_at, updated_by, rev)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})`)
    .bind(id, b.id, v.kind, v.label, v.persons ?? null, v.amount_cents, paid, paid ? at : null, at, user.email, at, user.email);
  await commit(db, { main, user, opId, entity: 'extra', entityId: id, action: 'create', changes: { booking_id: b.id, ...v } });
  return { record: await db.prepare('SELECT * FROM booking_extras WHERE id = ?').bind(id).first() };
}

async function extraUpdate(db, user, opId, p) {
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT * FROM booking_extras WHERE id = ?').bind(p.id).first();
  if (!cur || cur.deleted) throw notFound();
  if (cur.version !== p.version) throw new OpError(409, 'conflict', 'Nel frattempo è stato modificato da un altro dispositivo.', { current: cur });
  for (const k of Object.keys(p.changes || {})) if (!['label', 'amount_cents', 'paid', 'persons', 'paid_method'].includes(k)) throw bad('Campo non modificabile');
  const v = validateExtra(p.changes || {}, true);
  if (cur.kind === 'altro' && !('label' in v ? v.label : cur.label)) throw bad('Scrivi a cosa si riferisce');
  checkExtraAmount(cur.kind, v.amount_cents ?? cur.amount_cents);
  if ((v.amount_cents ?? cur.amount_cents) === 0) v.paid = 1;
  const changes = diff(cur, v);
  if (!Object.keys(changes).length) return { record: cur, unchanged: true };
  const cols = Object.keys(changes);
  const at = nowIso();
  const paidAt = 'paid' in changes ? (v.paid ? at : null) : cur.paid_at;
  const main = db.prepare(`UPDATE booking_extras SET ${cols.map((c) => `${c} = ?, `).join('')}paid_at = ?,
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ? AND version = ? AND deleted = 0`)
    .bind(...cols.map((c) => v[c]), paidAt, at, user.email, p.id, p.version);
  const done = await commit(db, { main, user, opId, entity: 'extra', entityId: p.id, action: 'update', changes });
  if (!done) throw new OpError(409, 'conflict', 'Nel frattempo è stato modificato da un altro dispositivo.');
  return { record: await db.prepare('SELECT * FROM booking_extras WHERE id = ?').bind(p.id).first() };
}

async function extraSetDeleted(db, user, opId, p, deleted) {
  if (!isId(p.id)) throw bad('Richiesta non valida');
  const main = db.prepare(`UPDATE booking_extras SET deleted = ?, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND deleted = ?`).bind(deleted, nowIso(), user.email, p.id, deleted ? 0 : 1);
  const done = await commit(db, { main, user, opId, entity: 'extra', entityId: p.id, action: deleted ? 'delete' : 'restore' });
  const record = await db.prepare('SELECT * FROM booking_extras WHERE id = ?').bind(p.id).first();
  if (!record) throw notFound();
  return { record, unchanged: !done };
}

/* ------------------------- Archivio della casa: spese ------------------------- */

const conflict = (current) => new OpError(409, 'conflict', 'Nel frattempo è stato modificato da un altro dispositivo.', current ? { current } : undefined);

async function checkHouseAndBooking(db, v, houseId) {
  if (houseId !== undefined && houseId !== null && !(await getHouse(db, houseId))) throw bad('Casa non valida');
  if (v.booking_id) {
    const b = await getBooking(db, v.booking_id);
    if (!b) throw bad('Prenotazione non valida');
    if (houseId && b.house_id !== houseId) throw bad('La prenotazione è di un’altra casa');
  }
}

async function expenseAdd(db, user, opId, p) {
  const r = validateExpense(p.expense || {});
  if (!r.ok) throw bad(r.error, { errors: { [r.field]: r.error } });
  const v = r.value;
  const houseId = p.expense?.house_id;
  if (!houseId) throw bad('Scegli la casa');
  await checkHouseAndBooking(db, v, houseId);
  const id = isId(p.id) ? p.id : crypto.randomUUID();
  if (await db.prepare('SELECT 1 FROM expenses WHERE id = ?').bind(id).first()) throw new OpError(409, 'state', 'Spesa già salvata.');
  const at = nowIso();
  const row = { id, house_id: houseId, ...v, booking_id: v.booking_id ?? null, paid_at: v.paid ? at : null };
  const cols = Object.keys(row);
  const main = db.prepare(`INSERT INTO expenses (${cols.join(', ')}, created_at, created_by, updated_at, updated_by, rev)
    VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ${REV_NEXT})`).bind(...cols.map((c) => row[c]), at, user.email, at, user.email);
  await commit(db, { main, user, opId, entity: 'expense', entityId: id, action: 'create', changes: row });
  return { record: await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first() };
}

async function expenseUpdate(db, user, opId, p) {
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT * FROM expenses WHERE id = ? AND deleted = 0').bind(p.id).first();
  if (!cur) throw notFound();
  if (cur.version !== p.version) throw conflict(cur);
  const allowed = ['category', 'label', 'amount_cents', 'date', 'period_from', 'period_to', 'due_date', 'paid', 'notes', 'booking_id', 'house_id'];
  const c = p.changes || {};
  for (const k of Object.keys(c)) if (!allowed.includes(k)) throw bad('Campo non modificabile');
  const r = validateExpense({ ...cur, ...c }, { partial: false });
  if (!r.ok) throw bad(r.error, { errors: { [r.field]: r.error } });
  const v = Object.fromEntries(Object.entries({ ...r.value, house_id: c.house_id ?? cur.house_id, booking_id: c.booking_id !== undefined ? (c.booking_id || null) : cur.booking_id })
    .filter(([k]) => k in c || k === 'house_id'));
  await checkHouseAndBooking(db, { booking_id: v.booking_id ?? cur.booking_id }, v.house_id);
  const changes = diff(cur, v);
  if (!Object.keys(changes).length) return { record: cur, unchanged: true };
  const cols = Object.keys(changes);
  const at = nowIso();
  const paidAt = 'paid' in changes ? (v.paid ? at : null) : cur.paid_at;
  const main = db.prepare(`UPDATE expenses SET ${cols.map((k) => `${k} = ?, `).join('')}paid_at = ?,
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ? AND version = ? AND deleted = 0`)
    .bind(...cols.map((k) => v[k]), paidAt, at, user.email, p.id, p.version);
  if (!(await commit(db, { main, user, opId, entity: 'expense', entityId: p.id, action: 'update', changes }))) throw conflict();
  return { record: await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(p.id).first() };
}

async function softDelete(db, user, opId, p, table, entity, deleted) {
  if (!isId(p.id)) throw bad('Richiesta non valida');
  const main = db.prepare(`UPDATE ${table} SET deleted = ?, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND deleted = ?`).bind(deleted, nowIso(), user.email, p.id, deleted ? 0 : 1);
  const done = await commit(db, { main, user, opId, entity, entityId: p.id, action: deleted ? 'delete' : 'restore' });
  const record = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(p.id).first();
  if (!record) throw notFound();
  return { record, unchanged: !done };
}

/* ------------------------ Archivio della casa: scadenze ------------------------ */

async function deadlineAdd(db, user, opId, p) {
  const r = validateDeadline(p.deadline || {});
  if (!r.ok) throw bad(r.error, { errors: { [r.field]: r.error } });
  const v = { ...r.value, house_id: r.value.house_id ?? null };
  await checkHouseAndBooking(db, {}, v.house_id);
  const id = isId(p.id) ? p.id : crypto.randomUUID();
  if (await db.prepare('SELECT 1 FROM deadlines WHERE id = ?').bind(id).first()) throw new OpError(409, 'state', 'Scadenza già salvata.');
  const at = nowIso();
  const row = { id, ...v };
  const cols = Object.keys(row);
  const main = db.prepare(`INSERT INTO deadlines (${cols.join(', ')}, created_at, created_by, updated_at, updated_by, rev)
    VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ${REV_NEXT})`).bind(...cols.map((c) => row[c]), at, user.email, at, user.email);
  await commit(db, { main, user, opId, entity: 'deadline', entityId: id, action: 'create', changes: row });
  return { record: await db.prepare('SELECT * FROM deadlines WHERE id = ?').bind(id).first() };
}

async function deadlineUpdate(db, user, opId, p) {
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT * FROM deadlines WHERE id = ? AND deleted = 0').bind(p.id).first();
  if (!cur) throw notFound();
  if (cur.version !== p.version) throw conflict(cur);
  const c = p.changes || {};
  const allowed = ['title', 'due_date', 'repeat', 'notice_days', 'notes', 'house_id', 'done'];
  for (const k of Object.keys(c)) if (!allowed.includes(k)) throw bad('Campo non modificabile');
  const r = validateDeadline(c, { partial: true });
  if (!r.ok) throw bad(r.error, { errors: { [r.field]: r.error } });
  const v = { ...r.value };
  if ('done' in c) v.done = c.done ? 1 : 0;
  if ('house_id' in c) await checkHouseAndBooking(db, {}, v.house_id);
  const changes = diff(cur, v);
  if (!Object.keys(changes).length) return { record: cur, unchanged: true };
  const cols = Object.keys(changes);
  const main = db.prepare(`UPDATE deadlines SET ${cols.map((k) => `${k} = ?, `).join('')}
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ? AND version = ? AND deleted = 0`)
    .bind(...cols.map((k) => v[k]), nowIso(), user.email, p.id, p.version);
  if (!(await commit(db, { main, user, opId, entity: 'deadline', entityId: p.id, action: 'update', changes }))) throw conflict();
  return { record: await db.prepare('SELECT * FROM deadlines WHERE id = ?').bind(p.id).first() };
}

/** Segna fatta: una scadenza unica si chiude; una ricorrente passa alla data successiva. */
async function deadlineDone(db, user, opId, p) {
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT * FROM deadlines WHERE id = ? AND deleted = 0').bind(p.id).first();
  if (!cur) throw notFound();
  if (cur.version !== p.version) throw conflict(cur);
  if (cur.done) return { record: cur, unchanged: true };
  const at = nowIso();
  const next = nextDue(cur.due_date, cur.repeat);
  const set = next ? { due_date: next, last_done_at: at } : { done: 1, last_done_at: at };
  const cols = Object.keys(set);
  const main = db.prepare(`UPDATE deadlines SET ${cols.map((k) => `${k} = ?, `).join('')}
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ? AND version = ? AND deleted = 0`)
    .bind(...cols.map((k) => set[k]), at, user.email, p.id, p.version);
  const changes = Object.fromEntries(cols.filter((k) => k !== 'last_done_at').map((k) => [k, [cur[k], set[k]]]));
  if (!(await commit(db, { main, user, opId, entity: 'deadline', entityId: p.id, action: 'done', changes }))) throw conflict();
  return { record: await db.prepare('SELECT * FROM deadlines WHERE id = ?').bind(p.id).first(), previous: { due_date: cur.due_date, done: cur.done } };
}

/* ------------------------------ Cose da fare ------------------------------ */

async function validateTaskFields(db, input, partial) {
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  if (!partial || has('title')) {
    const t = String(input.title || '').trim();
    if (!t) throw bad('Scrivi cosa c’è da fare');
    if (t.length > 200) throw bad('Testo troppo lungo');
    v.title = t;
  }
  if (has('due_date')) {
    if (input.due_date && !isIsoDate(input.due_date)) throw bad('Data non valida');
    v.due_date = input.due_date || null;
  }
  if (has('house_id')) {
    if (input.house_id && !(await getHouse(db, input.house_id))) throw bad('Casa non trovata');
    v.house_id = input.house_id || null;
  }
  if (has('booking_id')) {
    if (input.booking_id && !(await getBooking(db, input.booking_id))) throw bad('Prenotazione non trovata');
    v.booking_id = input.booking_id || null;
  }
  if (has('assignee')) {
    if (input.assignee) {
      const u = await db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(input.assignee).first();
      if (!u) throw bad('Persona non trovata');
    }
    v.assignee = input.assignee || null;
  }
  return v;
}

async function taskAdd(db, user, opId, p) {
  const v = await validateTaskFields(db, p.task || {}, false);
  const id = isId(p.id) ? p.id : crypto.randomUUID();
  const row = { id, title: v.title, due_date: v.due_date ?? null, house_id: v.house_id ?? null, booking_id: v.booking_id ?? null, assignee: v.assignee ?? null };
  const main = db.prepare(`INSERT INTO tasks (id, title, due_date, house_id, booking_id, assignee, created_at, created_by, rev)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})`)
    .bind(row.id, row.title, row.due_date, row.house_id, row.booking_id, row.assignee, nowIso(), user.email);
  await commit(db, { main, user, opId, entity: 'task', entityId: id, action: 'create', changes: row });
  return { record: await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first() };
}

async function taskToggle(db, user, opId, p) {
  if (!isId(p.id)) throw bad('Richiesta non valida');
  const done = p.done ? 1 : 0;
  const at = nowIso();
  const main = db.prepare(`UPDATE tasks SET done = ?, done_at = ?, done_by = ?, rev = ${REV_NEXT}
    WHERE id = ? AND done <> ? AND deleted = 0`)
    .bind(done, done ? at : null, done ? user.email : null, p.id, done);
  const changed = await commit(db, { main, user, opId, entity: 'task', entityId: p.id, action: done ? 'done' : 'undone' });
  const record = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(p.id).first();
  if (!record) throw notFound();
  return { record, unchanged: !changed };
}

async function taskUpdate(db, user, opId, p) {
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(p.id).first();
  if (!cur) throw notFound();
  const allowed = ['title', 'due_date', 'house_id', 'booking_id', 'assignee'];
  for (const k of Object.keys(p.changes || {})) if (!allowed.includes(k)) throw bad('Campo non modificabile');
  const v = await validateTaskFields(db, p.changes || {}, true);
  const changes = diff(cur, v);
  if (!Object.keys(changes).length) return { record: cur, unchanged: true };
  const cols = Object.keys(changes);
  const main = db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, rev = ${REV_NEXT}
    WHERE id = ? AND version = ?`).bind(...cols.map((c) => v[c]), p.id, p.version);
  const done = await commit(db, { main, user, opId, entity: 'task', entityId: p.id, action: 'update', changes });
  if (!done) {
    const now = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(p.id).first();
    throw new OpError(409, 'conflict', 'Nel frattempo è stata modificata da un altro dispositivo.', { current: now });
  }
  return { record: await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(p.id).first() };
}

async function taskSetDeleted(db, user, opId, p, deleted) {
  if (!isId(p.id)) throw bad('Richiesta non valida');
  const main = db.prepare(`UPDATE tasks SET deleted = ?, rev = ${REV_NEXT} WHERE id = ? AND deleted = ?`)
    .bind(deleted, p.id, deleted ? 0 : 1);
  const done = await commit(db, { main, user, opId, entity: 'task', entityId: p.id, action: deleted ? 'delete' : 'restore' });
  const record = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(p.id).first();
  if (!record) throw notFound();
  return { record, unchanged: !done };
}

/* --------------------------- Utenti e case (admin) --------------------------- */

function requireAdmin(user) {
  if (user.role !== 'admin') throw forbidden();
}

async function userAdd(db, user, opId, p) {
  requireAdmin(user);
  const email = String(p.email || '').trim().toLowerCase();
  const name = String(p.name || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) throw bad('Email non valida');
  if (!name || name.length > 80) throw bad('Scrivi il nome');
  if (!['admin', 'collaboratore'].includes(p.role)) throw bad('Ruolo non valido');
  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) throw bad('Questa email è già presente');
  const id = crypto.randomUUID();
  const main = db.prepare(`INSERT INTO users (id, email, name, role, active, created_at, rev)
    VALUES (?, ?, ?, ?, 1, ?, ${REV_NEXT})`).bind(id, email, name, p.role, nowIso());
  await commit(db, { main, user, opId, entity: 'user', entityId: id, action: 'create', changes: { email, name, role: p.role } });
  return { record: await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first() };
}

async function userUpdate(db, user, opId, p) {
  requireAdmin(user);
  if (!isId(p.id) || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT * FROM users WHERE id = ?').bind(p.id).first();
  if (!cur) throw notFound();
  const c = p.changes || {};
  const v = {};
  if ('name' in c) {
    const n = String(c.name || '').trim();
    if (!n || n.length > 80) throw bad('Nome non valido');
    v.name = n;
  }
  if ('role' in c) {
    if (!['admin', 'collaboratore'].includes(c.role)) throw bad('Ruolo non valido');
    v.role = c.role;
  }
  if ('active' in c) v.active = c.active ? 1 : 0;
  const losesAdmin = cur.role === 'admin' && cur.active === 1 && ((v.role && v.role !== 'admin') || v.active === 0);
  if (losesAdmin) {
    if (cur.id === user.id) throw bad('Non puoi togliere a te stesso il ruolo di amministratore.');
    const admins = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").first();
    if (admins.n <= 1) throw bad('Deve restare almeno un amministratore attivo.');
  }
  const changes = diff(cur, v);
  if (!Object.keys(changes).length) return { record: cur, unchanged: true };
  const cols = Object.keys(changes);
  const main = db.prepare(`UPDATE users SET ${cols.map((k) => `${k} = ?`).join(', ')}, version = version + 1, rev = ${REV_NEXT},
      updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`)
    .bind(...cols.map((k) => v[k]), nowIso(), user.email, p.id, p.version);
  const done = await commit(db, { main, user, opId, entity: 'user', entityId: p.id, action: 'update', changes });
  if (!done) throw new OpError(409, 'conflict', 'Nel frattempo è stato modificato da un altro dispositivo.');
  return { record: await db.prepare('SELECT * FROM users WHERE id = ?').bind(p.id).first() };
}

async function houseUpdate(db, user, opId, p) {
  requireAdmin(user);
  if (typeof p.id !== 'string' || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await getHouse(db, p.id);
  if (!cur) throw notFound();
  const c = p.changes || {};
  const v = {};
  for (const k of ['name', 'short_name']) {
    if (k in c) {
      const s = String(c[k] || '').trim();
      if (!s || s.length > 60) throw bad('Nome non valido');
      v[k] = s;
    }
  }
  for (const k of ['color', 'color_dark', 'color_soft']) {
    if (k in c) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(c[k])) throw bad('Colore non valido');
      v[k] = c[k].toUpperCase();
    }
  }
  if ('max_guests' in c) {
    const n = Number(c.max_guests);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw bad('Numero massimo di ospiti non valido');
    v.max_guests = n;
  }
  for (const k of ['checkin_time', 'checkout_time']) {
    if (k in c) {
      if (!isTime(c[k])) throw bad('Orario non valido');
      v[k] = c[k];
    }
  }
  if ('tourist_tax' in c) {
    const t = checkTaxSettings(c.tourist_tax);
    if (!t.ok) throw bad(t.error);
    v.tourist_tax = JSON.stringify(t.value);
  }
  for (const k of ['default_linens', 'default_towels', 'receipts_enabled']) {
    if (k in c) v[k] = c[k] ? 1 : 0;
  }
  if ('accounting' in c) {
    const r = checkAccountingSettings(c.accounting);
    if (!r.ok) throw bad(r.error, { errors: { [r.field || 'accounting']: r.error } });
    v.accounting = JSON.stringify(r.value);
  }
  if ('quote_settings' in c) {
    const r = checkQuoteSettings(c.quote_settings);
    if (!r.ok) throw bad(r.error, { errors: { [r.field || 'quote_settings']: r.error } });
    v.quote_settings = JSON.stringify(r.value);
  }
  if ('pricing' in c) {
    const r = checkPricingSettings(c.pricing);
    if (!r.ok) throw bad(r.error, { errors: { [r.field || 'pricing']: r.error } });
    v.pricing = JSON.stringify(r.value);
  }
  if ('contract_info' in c) {
    const r = checkContractInfo(c.contract_info);
    if (!r.ok) throw bad(r.error, { errors: { [r.field]: r.error } });
    v.contract_info = JSON.stringify(r.value);
  }
  const changes = diff(cur, v);
  // Nel registro non si copiano i dati personali del locatore: solo che i dati del contratto sono cambiati.
  if (changes.contract_info) changes.contract_info = ['…', 'aggiornati'];
  if (!Object.keys(changes).length) return { record: cur, unchanged: true };
  const cols = Object.keys(changes);
  const main = db.prepare(`UPDATE houses SET ${cols.map((k) => `${k} = ?`).join(', ')}, version = version + 1, rev = ${REV_NEXT},
      updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`)
    .bind(...cols.map((k) => v[k]), nowIso(), user.email, p.id, p.version);
  const done = await commit(db, { main, user, opId, entity: 'house', entityId: p.id, action: 'update', changes });
  if (!done) throw new OpError(409, 'conflict', 'Nel frattempo è stata modificata da un altro dispositivo.');
  return { record: publicHouse(await getHouse(db, p.id), true) };
}

/**
 * Casa come la vede l'app: i dati del contratto (con i dati personali del locatore) solo all'amministratore;
 * a tutti solo se il contratto si può già far firmare.
 */
export function publicHouse(house, isAdmin) {
  const ready = contractMissing(parseContractInfo(house)).length === 0 ? 1 : 0;
  if (isAdmin) return { ...house, contract_ready: ready };
  // Ai collaboratori: dell'immobile solo le regole che servono per i preventivi (luce compresa, comune, acconto),
  // mai i dati personali del locatore.
  const { contract_info: _c, ...rest } = house;
  const info = parseContractInfo(house);
  const shared = {};
  for (const k of ['city', 'kwh_day', 'kwh_price_cents', 'advance_pct']) if (info[k] !== undefined) shared[k] = info[k];
  return { ...rest, contract_ready: ready, contract_public: JSON.stringify(shared) };
}

/* ------------------------------- Calendari ------------------------------- */

/** Come l'app vede un calendario: il link riservato non esce mai dal server, si mostra solo il sito. */
export function publicCalendar(c) {
  return {
    id: c.id, house_id: c.house_id, channel: c.channel,
    connected: c.import_url ? 1 : 0, url_hint: c.import_url ? maskCalendarUrl(c.import_url) : null,
    last_sync_at: c.last_sync_at, last_ok_at: c.last_ok_at, last_error: c.last_error, last_count: c.last_count,
    // Codice del calendario che DigiHome dà a questa piattaforma (solo date occupate; lo vede solo l'amministratore).
    export_token: c.export_token,
    version: c.version, rev: c.rev,
  };
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Nuovo codice per il calendario dato alla piattaforma: il link vecchio smette di funzionare. */
async function calendarRegenerate(db, user, opId, p) {
  requireAdmin(user);
  if (typeof p.id !== 'string' || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT * FROM calendars WHERE id = ?').bind(p.id).first();
  if (!cur) throw notFound();
  const main = db.prepare(`UPDATE calendars SET export_token = ?, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND version = ?`).bind(newToken(), nowIso(), user.email, p.id, p.version);
  const done = await commit(db, { main, user, opId, entity: 'calendar', entityId: p.id, action: 'regenerate', changes: { link_per_la_piattaforma: ['vecchio', 'nuovo'] } });
  if (!done) throw new OpError(409, 'conflict', 'Nel frattempo è stato modificato da un altro dispositivo.');
  return { record: publicCalendar(await db.prepare('SELECT * FROM calendars WHERE id = ?').bind(p.id).first()) };
}

async function calendarUpdate(db, user, opId, p) {
  requireAdmin(user);
  if (typeof p.id !== 'string' || !Number.isInteger(p.version)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT * FROM calendars WHERE id = ?').bind(p.id).first();
  if (!cur) throw notFound();
  if (cur.version !== p.version) throw new OpError(409, 'conflict', 'Nel frattempo è stato modificato da un altro dispositivo.');
  const checked = checkCalendarUrl(cur.channel, p.import_url);
  if (!checked.ok) throw bad(checked.error, { errors: { import_url: checked.error } });
  if (checked.url === cur.import_url) return { record: publicCalendar(cur), unchanged: true };
  const main = db.prepare(`UPDATE calendars SET import_url = ?, last_sync_at = NULL, last_ok_at = NULL, last_error = NULL,
      last_count = NULL, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND version = ?`).bind(checked.url, nowIso(), user.email, p.id, p.version);
  // Nel registro non si scrive il link (è riservato): solo se è collegato o no.
  const state = (u) => (u ? 'collegato' : 'non collegato');
  const done = await commit(db, { main, user, opId, entity: 'calendar', entityId: p.id, action: 'update',
    changes: { calendario: [state(cur.import_url), checked.url ? (cur.import_url ? 'link cambiato' : 'collegato') : 'non collegato'] } });
  if (!done) throw new OpError(409, 'conflict', 'Nel frattempo è stato modificato da un altro dispositivo.');
  return { record: publicCalendar(await db.prepare('SELECT * FROM calendars WHERE id = ?').bind(p.id).first()) };
}

/* ------------------------------- Contabilità ------------------------------- */

/**
 * Soldi di una prenotazione: come sono stati pagati acconto e saldo (bonifico o contanti)
 * e, per Airbnb e Booking, quanto è arrivato davvero e quando.
 */
async function bookingMoney(db, user, opId, p) {
  if (!isId(p.id)) throw bad('Richiesta non valida');
  const cur = await getBooking(db, p.id);
  if (!cur) throw notFound();
  const c = p.changes || {};
  const v = {};
  for (const k of Object.keys(c)) if (!['deposit_method', 'balance_method', 'payout_cents', 'payout_at'].includes(k)) throw bad('Campo non modificabile');
  for (const k of ['deposit_method', 'balance_method']) {
    if (!(k in c)) continue;
    if (c[k] !== null && !Object.hasOwn(PAY_METHODS, c[k])) throw bad('Scegli bonifico o contanti');
    v[k] = c[k] || null;
  }
  if ('payout_cents' in c) {
    if (cur.channel === 'diretto') throw bad('Il pagamento della piattaforma vale solo per Airbnb e Booking');
    const n = c.payout_cents === null ? null : Number(c.payout_cents);
    if (n !== null && (!Number.isSafeInteger(n) || n < 0 || n > 100000000)) throw bad('Importo non valido', { errors: { payout_cents: 'Importo non valido' } });
    v.payout_cents = n;
  }
  if ('payout_at' in c) {
    if (c.payout_at !== null && !isIsoDate(c.payout_at)) throw bad('Data non valida', { errors: { payout_at: 'Data non valida' } });
    v.payout_at = c.payout_at || null;
  }
  const changes = diff(cur, v);
  if (!Object.keys(changes).length) return { record: cur, unchanged: true };
  const cols = Object.keys(changes);
  const at = nowIso();
  const main = db.prepare(`UPDATE bookings SET ${cols.map((k) => `${k} = ?, `).join('')}rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ?`)
    .bind(...cols.map((k) => v[k]), at, user.email, p.id);
  const done = await commit(db, { main, user, opId, entity: 'booking', entityId: p.id, action: 'money', changes });
  if (!done) await explainBookingFailure(db, p.id);
  return { record: await getBooking(db, p.id) };
}

/** Versamento della tassa di soggiorno al Comune o della cedolare. */
/* ------------------------------- Ricevuta del saldo ------------------------------- */

/**
 * Ricevuta del saldo di una prenotazione diretta (solo l'amministratore: contiene i dati del locatore).
 * Una sola per prenotazione: se c'è già si restituisce quella. Numero progressivo per casa e anno (della data di oggi),
 * assegnato nella stessa istruzione che la salva: due ricevute non possono avere lo stesso numero.
 */
async function payReceiptIssue(db, user, opId, p) {
  requireAdmin(user);
  if (!isId(p.booking_id)) throw bad('Richiesta non valida');
  const existing = await db.prepare('SELECT * FROM pay_receipts WHERE booking_id = ?').bind(p.booking_id).first();
  if (existing) return { record: existing, unchanged: true };
  const b = await getBooking(db, p.booking_id);
  if (!b) throw notFound();
  const house = await getHouse(db, b.house_id);
  if (!house.receipts_enabled) throw bad('La ricevuta non è attiva per questa casa (Impostazioni → Case → Casa).');
  if (b.channel !== 'diretto') throw bad('La ricevuta del saldo è solo per le prenotazioni dirette.');
  if (b.stage === 'cancellata') throw bad('Prenotazione cancellata.');
  const amount = balanceDue(b);
  if (!(amount > 0)) throw bad('Non c’è un saldo da indicare nella ricevuta.');
  const info = parseContractInfo(house);
  const missing = ['landlord_name', 'city', 'address'].filter((k) => !info[k]);
  if (missing.length) throw bad('Mancano i dati del locatore o dell’immobile: completa Impostazioni → Case → Dati del contratto.');
  const today = todayRome();
  const year = Number(today.slice(0, 4));
  const data = {
    landlord_name: info.landlord_name, landlord_sal: info.landlord_sal || 'M', landlord_cf: info.landlord_cf || null,
    landlord_residence: info.landlord_residence || null, city: info.city, address: info.address, cin: info.cin || null,
    guest_name: b.guest_name, check_in: b.check_in, check_out: b.check_out, method: b.balance_method || null, issued_on: today,
  };
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    const main = db.prepare(`INSERT INTO pay_receipts (id, booking_id, house_id, year, number, amount_cents, data, issued_at, issued_by, rev)
      SELECT ?, ?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM pay_receipts WHERE house_id = ? AND year = ?), ?, ?, ?, ?, ${REV_NEXT}
      WHERE NOT EXISTS (SELECT 1 FROM pay_receipts WHERE booking_id = ?)`)
      .bind(id, b.id, house.id, year, house.id, year, amount, JSON.stringify(data), nowIso(), user.email, b.id);
    let done = false;
    try {
      done = await commit(db, { main, user, opId, entity: 'payreceipt', entityId: id, action: 'create', changes: { prenotazione: b.id, anno: year, importo: amount } });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e; // stesso numero preso nello stesso istante: si riprova
      continue;
    }
    const rec = await db.prepare('SELECT * FROM pay_receipts WHERE booking_id = ?').bind(b.id).first();
    if (rec) return { record: rec, unchanged: !done };
  }
  throw new OpError(409, 'conflict', 'Ricevuta non creata. Riprova.');
}

/* ------------------------------- Listino prezzi ------------------------------- */

/**
 * Netti per settimana del listino (solo l'amministratore: listino e regole di prezzo sono impostazioni).
 * p: { house_id, year, weeks: { 'AAAA-MM-GG': centesimi | null } } → si uniscono a quelli già salvati (null = togli).
 * Più dispositivi possono scrivere settimane diverse: in caso di scrittura contemporanea si rilegge e si riprova.
 */
async function priceSet(db, user, opId, p) {
  requireAdmin(user);
  const house = typeof p.house_id === 'string' ? await getHouse(db, p.house_id) : null;
  if (!house) throw bad('Casa non trovata');
  const r = checkWeekChanges(p.year, p.weeks);
  if (!r.ok) throw bad(r.error);
  const id = `${house.id}:${p.year}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await db.prepare('SELECT * FROM price_lists WHERE id = ?').bind(id).first();
    let weeks = {};
    try { weeks = cur ? JSON.parse(cur.weeks || '{}') : {}; } catch { weeks = {}; }
    const changes = {};
    for (const [k, c] of Object.entries(r.value)) {
      const before = weeks[k] ?? null;
      if (before === c) continue;
      changes[k] = [before, c];
      if (c === null) delete weeks[k]; else weeks[k] = c;
    }
    if (!Object.keys(changes).length) return cur ? { record: cur, unchanged: true } : { unchanged: true };
    if (Object.keys(weeks).length > 120) throw bad('Troppe settimane in questo listino');
    const json = JSON.stringify(Object.fromEntries(Object.entries(weeks).sort(([a], [b]) => (a < b ? -1 : 1))));
    const at = nowIso();
    const main = cur
      ? db.prepare(`UPDATE price_lists SET weeks = ?, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
          WHERE id = ? AND version = ?`).bind(json, at, user.email, id, cur.version)
      : db.prepare(`INSERT INTO price_lists (id, house_id, year, weeks, created_at, created_by, updated_at, updated_by, rev)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT} WHERE NOT EXISTS (SELECT 1 FROM price_lists WHERE id = ?)`)
        .bind(id, house.id, p.year, json, at, user.email, at, user.email, id);
    const done = await commit(db, { main, user, opId, entity: 'price', entityId: id, action: 'update', changes: { anno: p.year, settimane: changes } });
    if (done) return { record: await db.prepare('SELECT * FROM price_lists WHERE id = ?').bind(id).first() };
  }
  throw new OpError(409, 'conflict', 'Il listino è stato modificato nello stesso momento da un altro dispositivo. Riprova.');
}

async function remittanceAdd(db, user, opId, p) {
  const r = checkRemittance(p.remittance || {});
  if (!r.ok) throw bad(r.error, { errors: { [r.field]: r.error } });
  const houseId = p.remittance && p.remittance.house_id;
  if (!houseId || !(await getHouse(db, houseId))) throw bad('Scegli la casa');
  const id = isId(p.id) ? p.id : crypto.randomUUID();
  if (await db.prepare('SELECT 1 FROM remittances WHERE id = ?').bind(id).first()) throw new OpError(409, 'state', 'Versamento già salvato.');
  const at = nowIso();
  const row = { id, house_id: houseId, ...r.value };
  const cols = Object.keys(row);
  const main = db.prepare(`INSERT INTO remittances (${cols.join(', ')}, created_at, created_by, updated_at, updated_by, rev)
    VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ${REV_NEXT})`).bind(...cols.map((k) => row[k]), at, user.email, at, user.email);
  await commit(db, { main, user, opId, entity: 'remittance', entityId: id, action: 'create', changes: row });
  return { record: await db.prepare('SELECT * FROM remittances WHERE id = ?').bind(id).first() };
}

/* ------------------------------- Importazione ------------------------------- */

const IMPORT_MAX = 100;

/**
 * Importazione di prenotazioni da un file (vecchio Excel): solo l'amministratore, al massimo 100 per volta.
 * Ogni riga si controlla come una prenotazione nuova; le date già occupate si saltano (doppioni).
 * Soggiorni già finiti → "chiusa"; in corso → "in_casa"; futuri → "confermata".
 * Restituisce { imported, skipped: [{ index, reason }] }.
 */
async function bookingImport(db, user, opId, p) {
  requireAdmin(user);
  if (!Array.isArray(p.rows) || p.rows.length === 0 || p.rows.length > IMPORT_MAX) throw bad(`Da 1 a ${IMPORT_MAX} prenotazioni per volta`);
  const houses = Object.fromEntries(((await db.prepare('SELECT * FROM houses').all()).results || []).map((x) => [x.id, x]));
  const today = todayRome();
  const at = nowIso();
  const skipped = [];
  const stmts = [];
  const ids = [];
  p.rows.forEach((r, index) => {
    const house = houses[r && r.house_id];
    if (!house) { skipped.push({ index, reason: 'casa non valida' }); return; }
    // Per lo storico il numero di persone può superare il massimo di oggi: si controlla con un limite largo.
    const { ok, value, errors } = validateBooking({ ...r, guest_name: r.guest_name || 'Ospite (importato)' }, { house: { ...house, max_guests: 50 } });
    if (!ok) { skipped.push({ index, reason: Object.values(errors)[0] }); return; }
    const id = crypto.randomUUID();
    const stage = value.check_out <= today ? 'chiusa' : value.check_in <= today ? 'in_casa' : 'confermata';
    const row = {
      id, house_id: house.id, channel: value.channel, guest_name: value.guest_name, phone: value.phone ?? null, email: null,
      guests: value.guests, check_in: value.check_in, check_out: value.check_out, total_cents: value.total_cents ?? 0,
      deposit_cents: 0, deposit_paid: 0, security_cents: 0, security_status: 'nessuna', stage,
      notes: 'Importata dal vecchio file',
      // Data della prenotazione, se il file ce l'ha (serve al ritmo delle prenotazioni nel listino).
      booked_on: isIsoDate(r.booked_on) && r.booked_on <= value.check_in ? r.booked_on : null,
    };
    const cols = Object.keys(row);
    ids.push({ id, index });
    stmts.push(db.prepare(`INSERT INTO bookings (${cols.join(', ')}, created_at, created_by, updated_at, updated_by, rev)
      SELECT ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ${REV_NEXT}
      WHERE NOT ${OVERLAP}`)
      .bind(...cols.map((c) => row[c]), at, user.email, at, user.email, row.house_id, id, row.check_out, row.check_in));
  });
  if (!stmts.length) {
    await db.prepare(`INSERT INTO ops (op_id, at, user_email, result) VALUES (?, ?, ?, ?)`)
      .bind(opId, at, user.email, JSON.stringify({ imported: 0, skipped })).run();
    return { imported: 0, skipped };
  }
  // Tutto in una sola transazione: prenotazioni, registro e codice dell'operazione (niente doppioni se si riprova).
  const idsJson = JSON.stringify(ids.map((x) => x.id));
  const count = '(SELECT COUNT(*) FROM bookings WHERE id IN (SELECT value FROM json_each(?)))';
  const results = await db.batch([
    ...stmts,
    db.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'rev'`),
    db.prepare(`INSERT INTO audit_log (at, user_email, entity, entity_id, action, changes)
      VALUES (?, ?, 'import', ?, 'import', json_object('importate', ${count}, 'righe', ?))`).bind(at, user.email, opId, idsJson, p.rows.length),
    db.prepare(`INSERT INTO ops (op_id, at, user_email, result) VALUES (?, ?, ?, json_object('imported', ${count}, 'skipped', json(?)))`)
      .bind(opId, at, user.email, idsJson, JSON.stringify(skipped)),
  ]);
  const inserted = ids.filter((x, i) => results[i].meta.changes === 1);
  for (const x of ids) if (!inserted.includes(x)) skipped.push({ index: x.index, reason: 'date già occupate (forse è già nel gestionale)' });
  skipped.sort((x, y) => x.index - y.index);
  const out = { imported: inserted.length, skipped };
  return out;
}

/* ------------------------------- Contatore della luce ------------------------------- */

/**
 * Lettura del contatore all'arrivo (start) o alla partenza (end), in decimi di kWh; null la toglie.
 * Spunta da sola il passaggio "contatori" del check-in o del check-out. Nelle prenotazioni dirette,
 * con entrambe le letture, mette (o aggiorna) l'extra "Luce" con i kWh oltre quelli compresi.
 */
async function bookingMeter(db, user, opId, p) {
  if (!isId(p.id) || !['start', 'end'].includes(p.which)) throw bad('Richiesta non valida');
  // Le tre fasce del contatore (A1, A2, A3) in decimi di kWh; la lettura è la loro somma. null toglie la lettura.
  let bands = null;
  if (p.bands !== null) {
    if (!Array.isArray(p.bands) || p.bands.length !== 3
      || !p.bands.every((x) => Number.isSafeInteger(x) && x >= 0 && x <= 333333333)) {
      throw bad('Lettura non valida: servono le tre fasce A1, A2 e A3', { errors: { value: 'Lettura non valida' } });
    }
    bands = p.bands;
  }
  const value = bands ? bands[0] + bands[1] + bands[2] : null;
  const cur = await getBooking(db, p.id);
  if (!cur) throw notFound();
  const stages = p.which === 'start' ? ['confermata', 'in_casa', 'partita'] : ['in_casa', 'partita'];
  if (!stages.includes(cur.stage)) {
    throw new OpError(409, 'state', p.which === 'start' ? 'La lettura di arrivo si scrive al check-in.' : 'La lettura di partenza si scrive al check-out.');
  }
  const next = { ...cur, [`meter_${p.which}`]: value };
  if (Number.isInteger(next.meter_start) && Number.isInteger(next.meter_end) && next.meter_end < next.meter_start) {
    throw bad('La lettura di partenza è più bassa di quella di arrivo: controlla i numeri.', { errors: { value: 'Più bassa della lettura di arrivo' } });
  }
  const at = nowIso();
  const col = p.which === 'start' ? 'checkin_steps' : 'checkout_steps';
  const main = db.prepare(`UPDATE bookings SET meter_${p.which} = ?, meter_${p.which}_bands = ?, meter_${p.which}_at = ?,
      ${col} = json_set(${col}, '$.contatori', json(?)), rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND stage IN (${stages.map(() => '?').join(', ')})`)
    .bind(value, bands ? JSON.stringify(bands) : null, value === null ? null : at, value === null ? '0' : '1', at, user.email, p.id, ...stages);
  const marked = `EXISTS (SELECT 1 FROM bookings WHERE id = ? AND rev = ${REV_NEXT})`;

  // Extra della luce (solo dirette: con Airbnb e Booking si decide a mano dalla scheda).
  const also = [];
  let extraId = null;
  if (cur.channel === 'diretto') {
    const house = await getHouse(db, cur.house_id);
    const calc = meterCalc(next, parseContractInfo(house));
    const existing = await db.prepare("SELECT * FROM booking_extras WHERE booking_id = ? AND kind = 'luce' AND deleted = 0").bind(cur.id).first();
    if (calc.cost > 0) {
      const label = meterExtraLabel(calc);
      if (existing && !existing.paid) {
        extraId = existing.id;
        also.push(db.prepare(`UPDATE booking_extras SET amount_cents = ?, label = ?, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
          WHERE id = ? AND paid = 0 AND ${marked}`).bind(calc.cost, label, at, user.email, existing.id, cur.id));
      } else if (!existing) {
        extraId = crypto.randomUUID();
        also.push(db.prepare(`INSERT INTO booking_extras (id, booking_id, kind, label, amount_cents, paid, created_at, created_by, updated_at, updated_by, rev)
          SELECT ?, ?, 'luce', ?, ?, 0, ?, ?, ?, ?, ${REV_NEXT} WHERE ${marked}`).bind(extraId, cur.id, label, calc.cost, at, user.email, at, user.email, cur.id));
      }
    } else if (existing && !existing.paid) {
      extraId = existing.id;
      also.push(db.prepare(`UPDATE booking_extras SET deleted = 1, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
        WHERE id = ? AND paid = 0 AND ${marked}`).bind(at, user.email, existing.id, cur.id));
    }
  }
  const done = await commit(db, { main, also, user, opId, entity: 'booking', entityId: p.id, action: 'meter',
    changes: { [`meter_${p.which}`]: [cur[`meter_${p.which}`], value], fasce: bands } });
  if (!done) await explainBookingFailure(db, p.id);
  const related = [];
  if (extraId) related.push(['extra', await db.prepare('SELECT * FROM booking_extras WHERE id = ?').bind(extraId).first()]);
  return { record: await getBooking(db, p.id), related };
}

/* ------------------------------- Contratti ------------------------------- */

const CONTRACT_STAGES = ['confermata', 'in_casa'];

/** Come l'app vede un contratto nell'elenco generale: solo i dati per sapere se c'è, mai testo, dati o firme. */
export function contractMeta(c) {
  return {
    id: c.id, booking_id: c.booking_id, house_id: c.house_id, template: c.template, lang: c.lang || 'it',
    check_in: c.check_in, check_out: c.check_out, guests: c.guests,
    signed_at: c.signed_at, signer_name: c.signer_name, hash: c.hash, purge_after: c.purge_after,
    deleted: c.deleted, version: c.version, rev: c.rev,
  };
}

/** Testo del contratto da mostrare prima della firma (dati dell'ospite ancora da scrivere). */
export async function contractDraft(db, bookingId, lang = 'it') {
  if (typeof lang !== 'string' || !Object.hasOwn(LANGS, lang)) throw bad('Lingua non valida');
  const b = await getBooking(db, bookingId);
  if (!b) throw notFound();
  if (b.channel !== 'diretto') throw bad('Il contratto si fa solo per le prenotazioni dirette.');
  const house = await getHouse(db, b.house_id);
  const info = parseContractInfo(house);
  const missing = contractMissing(info);
  if (missing.length) return { ready: false, missing };
  return { ready: true, lang, blocks: buildContract({ house, info, booking: b, lang }) };
}

async function contractSign(db, user, opId, p) {
  if (!isId(p.id) || !isId(p.booking_id)) throw bad('Richiesta non valida');
  if (p.accepted !== true) throw bad('L’ospite deve confermare di aver letto il contratto e l’informativa.');
  const lang = p.lang === undefined ? 'it' : p.lang;
  if (typeof lang !== 'string' || !Object.hasOwn(LANGS, lang)) throw bad('Lingua non valida');
  const b = await getBooking(db, p.booking_id);
  if (!b) throw notFound();
  if (b.channel !== 'diretto') throw bad('Il contratto si fa solo per le prenotazioni dirette.');
  if (!CONTRACT_STAGES.includes(b.stage)) throw new OpError(409, 'state', 'Il contratto si firma prima o durante il soggiorno.');
  const house = await getHouse(db, b.house_id);
  const info = parseContractInfo(house);
  const missing = contractMissing(info);
  if (missing.length) throw new OpError(409, 'contract_info', `Completa i dati del contratto in Impostazioni: ${missing.join(', ')}.`);
  const g = checkGuest(p.guest, todayRome());
  if (!g.ok) throw bad(g.error, { errors: { [g.field]: g.error } });
  const gs = checkSignature(p.guest_sign);
  if (!gs.ok) throw bad(`Firma dell’ospite: ${gs.error.toLowerCase()}`, { errors: { guest_sign: gs.error } });
  const hs = checkSignature(p.host_sign);
  if (!hs.ok) throw bad(`Firma del locatore: ${hs.error.toLowerCase()}`, { errors: { host_sign: hs.error } });
  if (await db.prepare('SELECT 1 FROM contracts WHERE id = ?').bind(p.id).first()) throw new OpError(409, 'state', 'Contratto già salvato.');
  const dup = () => new OpError(409, 'state', 'Per questa prenotazione c’è già un contratto firmato.');
  if (await db.prepare('SELECT 1 FROM contracts WHERE booking_id = ? AND deleted = 0').bind(b.id).first()) throw dup();

  // Il testo lo ricrea il server con i dati di adesso: quello firmato è esattamente questo.
  const signedAt = nowIso();
  const row = {
    id: p.id, template: CONTRACT_TEMPLATE, lang, booking_id: b.id, house_id: house.id,
    body: JSON.stringify(buildContract({ house, info, booking: b, guest: g.value, signedAt, lang })),
    guest: JSON.stringify(g.value), guest_sign: p.guest_sign, host_sign: p.host_sign, signed_at: signedAt,
  };
  row.hash = await sha256Hex(hashInput(row));
  Object.assign(row, {
    check_in: b.check_in, check_out: b.check_out, guests: b.guests,
    signed_by: user.email, signer_name: user.name || null, purge_after: purgeDate(b.check_out),
  });
  const cols = Object.keys(row);
  const marked = `EXISTS (SELECT 1 FROM contracts WHERE id = ? AND rev = ${REV_NEXT})`;
  const main = db.prepare(`INSERT INTO contracts (${cols.join(', ')}, created_at, updated_at, updated_by, rev)
    SELECT ${cols.map(() => '?').join(', ')}, ?, ?, ?, ${REV_NEXT}
    WHERE NOT EXISTS (SELECT 1 FROM contracts WHERE booking_id = ? AND deleted = 0)
      AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND stage IN ('confermata', 'in_casa'))`)
    .bind(...cols.map((k) => row[k]), signedAt, signedAt, user.email, b.id, b.id);
  // Firmato il contratto, il passaggio "Contratto firmato" del check-in si spunta da solo.
  const also = [db.prepare(`UPDATE bookings SET checkin_steps = json_set(checkin_steps, '$.contratto', json('1')),
      rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ? AND ${marked}`).bind(signedAt, user.email, b.id, p.id)];
  let done;
  try {
    done = await commit(db, { main, also, user, opId, entity: 'contract', entityId: p.id, action: 'sign',
      changes: { prenotazione: [null, b.id], impronta: [null, row.hash] } });
  } catch (e) {
    if (/UNIQUE constraint failed: contracts/.test(String(e && e.message))) throw dup();
    throw e;
  }
  if (!done) {
    const cur = await getBooking(db, b.id);
    if (!cur || !CONTRACT_STAGES.includes(cur.stage)) throw new OpError(409, 'state', 'Il contratto si firma prima o durante il soggiorno.');
    throw dup();
  }
  const saved = await db.prepare('SELECT * FROM contracts WHERE id = ?').bind(p.id).first();
  return { record: contractMeta(saved), booking: await getBooking(db, b.id) };
}

/** Elimina un contratto (per rifarlo): il contenuto si cancella subito, la riga sparisce dopo 30 giorni. */
async function contractDelete(db, user, opId, p) {
  requireAdmin(user);
  if (!isId(p.id)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT id, booking_id FROM contracts WHERE id = ? AND deleted = 0').bind(p.id).first();
  if (!cur) throw notFound();
  const at = nowIso();
  const main = db.prepare(`UPDATE contracts SET deleted = 1, body = '[]', guest = '{}', guest_sign = '', host_sign = '', hash = '',
      purge_after = ?, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ? AND deleted = 0`)
    .bind(todayPlus(30), at, user.email, p.id);
  const also = [db.prepare(`UPDATE bookings SET checkin_steps = json_set(checkin_steps, '$.contratto', json('0')),
      rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND stage IN ('confermata', 'in_casa') AND EXISTS (SELECT 1 FROM contracts WHERE id = ? AND rev = ${REV_NEXT})`)
    .bind(at, user.email, cur.booking_id, p.id)];
  const done = await commit(db, { main, also, user, opId, entity: 'contract', entityId: p.id, action: 'delete', changes: { prenotazione: [cur.booking_id, null] } });
  if (!done) throw notFound();
  const saved = await db.prepare('SELECT * FROM contracts WHERE id = ?').bind(p.id).first();
  return { record: contractMeta(saved), booking: await getBooking(db, cur.booking_id) };
}

function todayPlus(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Contratto completo (per il PDF): l'amministratore sempre, chi l'ha fatto firmare nelle 24 ore successive. */
export async function readContract(db, user, id) {
  const c = await db.prepare(`SELECT c.*, h.name AS house_name FROM contracts c JOIN houses h ON h.id = c.house_id
    WHERE c.id = ? AND c.deleted = 0`).bind(id).first();
  if (!c) throw notFound();
  const recent = Date.now() - Date.parse(c.signed_at) < 24 * 60 * 60 * 1000;
  if (user.role !== 'admin' && !(c.signed_by === user.email && recent)) {
    throw new OpError(403, 'forbidden', 'Il contratto firmato lo può riaprire solo l’amministratore.');
  }
  return { ...contractMeta(c), house_name: c.house_name, body: JSON.parse(c.body), guest: JSON.parse(c.guest),
    guest_sign: c.guest_sign, host_sign: c.host_sign };
}

/**
 * Cancellazione automatica (dal controllo programmato): contratti oltre il periodo di conservazione
 * ed eliminati da più di 30 giorni. Restituisce quanti contratti validi sono stati cancellati.
 */
export async function purgeContracts(db, today = todayRome(), systemEmail = 'sistema') {
  const expired = "purge_after < ?";
  const r = await db.batch([
    db.prepare(`INSERT INTO audit_log (at, user_email, entity, entity_id, action, changes)
      SELECT ?, ?, 'contract', id, 'purge', json_object('prenotazione', json_array(booking_id, NULL)) FROM contracts WHERE ${expired} AND deleted = 0`)
      .bind(nowIso(), systemEmail, today),
    db.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'rev' AND EXISTS (SELECT 1 FROM contracts WHERE ${expired} AND deleted = 0)`).bind(today),
    db.prepare(`DELETE FROM contracts WHERE ${expired}`).bind(today),
  ]);
  return r[0].meta.changes;
}

/* ------------------------------- Smistamento ------------------------------- */

const HANDLERS = {
  'booking.create': bookingCreate,
  'booking.update': bookingUpdate,
  'booking.step': bookingStep,
  'booking.checkin': bookingCompleteCheckin,
  'booking.checkout': bookingCompleteCheckout,
  'booking.close': bookingClose,
  'booking.cancel': bookingCancel,
  'booking.restore': bookingRestore,
  'booking.step_back': bookingStepBack,
  'booking.ext_ack': bookingExtAck,
  'calendar.update': calendarUpdate,
  'calendar.regenerate': calendarRegenerate,
  'extra.add': extraAdd,
  'extra.update': extraUpdate,
  'extra.delete': (db, u, o, p) => extraSetDeleted(db, u, o, p, 1),
  'extra.restore': (db, u, o, p) => extraSetDeleted(db, u, o, p, 0),
  'note.add': noteAdd,
  'note.delete': (db, u, o, p) => noteSetDeleted(db, u, o, p, 1),
  'note.restore': (db, u, o, p) => noteSetDeleted(db, u, o, p, 0),
  'expense.add': expenseAdd,
  'expense.update': expenseUpdate,
  'expense.delete': (db, u, o, p) => softDelete(db, u, o, p, 'expenses', 'expense', 1),
  'expense.restore': (db, u, o, p) => softDelete(db, u, o, p, 'expenses', 'expense', 0),
  'deadline.add': deadlineAdd,
  'deadline.update': deadlineUpdate,
  'deadline.done': deadlineDone,
  'deadline.delete': (db, u, o, p) => softDelete(db, u, o, p, 'deadlines', 'deadline', 1),
  'deadline.restore': (db, u, o, p) => softDelete(db, u, o, p, 'deadlines', 'deadline', 0),
  'task.add': taskAdd,
  'task.toggle': taskToggle,
  'task.update': taskUpdate,
  'task.delete': (db, u, o, p) => taskSetDeleted(db, u, o, p, 1),
  'task.restore': (db, u, o, p) => taskSetDeleted(db, u, o, p, 0),
  'user.add': userAdd,
  'user.update': userUpdate,
  'house.update': houseUpdate,
  'booking.meter': bookingMeter,
  'booking.money': bookingMoney,
  'remittance.add': remittanceAdd,
  'price.set': priceSet,
  'payreceipt.issue': payReceiptIssue,
  'remittance.delete': (db, user, opId, p) => softDelete(db, user, opId, p, 'remittances', 'remittance', 1),
  'remittance.restore': (db, user, opId, p) => softDelete(db, user, opId, p, 'remittances', 'remittance', 0),
  'booking.import': bookingImport,
  'contract.sign': contractSign,
  'contract.delete': contractDelete,
};

/**
 * Altri moduli (ospiti, DMS) aggiungono qui le loro operazioni, senza import circolari.
 * private: operazioni con dati personali, che non passano mai dalla coda offline (/api/ops le rifiuta).
 */
export const PRIVATE_OPS = new Set(['contract.sign']);
export function registerOps(map, { private: isPrivate = false } = {}) {
  for (const [type, fn] of Object.entries(map)) {
    if (HANDLERS[type]) throw new Error(`Operazione già registrata: ${type}`);
    HANDLERS[type] = fn;
    if (isPrivate) PRIVATE_OPS.add(type);
  }
}

/**
 * Esegue un'operazione. Se lo stesso opId è già stato eseguito, non la ripete.
 * Restituisce { ok: true, record?, replay? } oppure lancia OpError.
 */
export async function runOp(db, user, body) {
  if (!body || typeof body !== 'object') throw bad('Richiesta non valida');
  const { opId, type, payload } = body;
  if (typeof opId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(opId)) throw bad('Codice operazione mancante');
  const handler = HANDLERS[type];
  if (!handler) throw bad('Operazione sconosciuta');

  const prev = await db.prepare('SELECT user_email, result FROM ops WHERE op_id = ?').bind(opId).first();
  if (prev) {
    if (prev.user_email !== user.email) throw bad('Codice operazione non valido');
    return { ok: true, replay: true, ...JSON.parse(prev.result) };
  }
  try {
    const out = await handler(db, user, opId, payload || {});
    return { ok: true, ...out };
  } catch (e) {
    // Due invii identici arrivati insieme: il secondo trova il codice già usato.
    if (!(e instanceof OpError) && /UNIQUE constraint failed: ops\.op_id/.test(String(e && e.message))) {
      const again = await db.prepare('SELECT result FROM ops WHERE op_id = ?').bind(opId).first();
      if (again) return { ok: true, replay: true, ...JSON.parse(again.result) };
    }
    throw e;
  }
}

export { CHANNELS };
