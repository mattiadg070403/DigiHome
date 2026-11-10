// Tutte le modifiche ai dati passano da qui.
// Ogni operazione: controllo, scrittura, registro modifiche e contatore in un'unica transazione.

import { CHANNELS, checkinSteps, checkoutSteps, missingRequired, parseSteps, validateBooking } from '../public/shared/booking.js';
import { daysBetween, fmtShort, isIsoDate, isTime } from '../public/shared/dates.js';
import { checkCalendarUrl, maskCalendarUrl } from '../public/shared/calendar.js';
import { checkTaxSettings } from '../public/shared/tax.js';

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
const TABLES = { booking: 'bookings', note: 'booking_notes', task: 'tasks', user: 'users', house: 'houses', calendar: 'calendars', extra: 'booking_extras' };

export async function commit(db, { main, user, opId, entity, entityId, action, changes }) {
  const table = TABLES[entity];
  const at = nowIso();
  const marked = `EXISTS (SELECT 1 FROM ${table} WHERE id = ?
    AND rev = (SELECT value FROM meta WHERE key = 'rev') + 1)`;
  const stmts = [
    main,
    db.prepare(`INSERT INTO audit_log (at, user_email, entity, entity_id, action, changes)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${marked}`)
      .bind(at, user.email, entity, entityId, action, changes ? JSON.stringify(changes) : null, entityId),
    db.prepare(`INSERT INTO ops (op_id, at, user_email, result)
      SELECT ?, ?, ?, json_object('entity', ?, 'id', ?, 'rev', (SELECT value FROM meta WHERE key = 'rev') + 1)
      WHERE ${marked}`).bind(opId, at, user.email, entity, entityId, entityId),
    db.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'rev' AND ${marked}`).bind(entityId),
  ];
  const results = await db.batch(stmts);
  return results[3].meta.changes === 1;
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
  for (const k of Object.keys(p.changes || {})) if (!['label', 'amount_cents', 'paid', 'persons'].includes(k)) throw bad('Campo non modificabile');
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
  const changes = diff(cur, v);
  if (!Object.keys(changes).length) return { record: cur, unchanged: true };
  const cols = Object.keys(changes);
  const main = db.prepare(`UPDATE houses SET ${cols.map((k) => `${k} = ?`).join(', ')}, version = version + 1, rev = ${REV_NEXT},
      updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`)
    .bind(...cols.map((k) => v[k]), nowIso(), user.email, p.id, p.version);
  const done = await commit(db, { main, user, opId, entity: 'house', entityId: p.id, action: 'update', changes });
  if (!done) throw new OpError(409, 'conflict', 'Nel frattempo è stata modificata da un altro dispositivo.');
  return { record: await getHouse(db, p.id) };
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
  'task.add': taskAdd,
  'task.toggle': taskToggle,
  'task.update': taskUpdate,
  'task.delete': (db, u, o, p) => taskSetDeleted(db, u, o, p, 1),
  'task.restore': (db, u, o, p) => taskSetDeleted(db, u, o, p, 0),
  'user.add': userAdd,
  'user.update': userUpdate,
  'house.update': houseUpdate,
};

export const OP_TYPES = Object.keys(HANDLERS);

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
