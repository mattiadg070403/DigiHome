// Ospiti di una prenotazione (dati per Alloggiati Web e DMS Puglia).
//
// I dati degli ospiti NON fanno parte dello stato che l'app scarica su ogni dispositivo: si leggono solo
// aprendo la scheda (GET /api/bookings/:id/guests) e si salvano solo in linea (POST /api/guests),
// mai dalla coda delle modifiche offline. Nel registro delle modifiche finiscono i nomi dei campi, mai i valori.

import { OpError, REV_NEXT, commit, registerOps } from './ops.js';
import { docDropped, guestMissing, nameTranscription, plainDoc, plainName, MAX_GUESTS } from '../public/shared/alloggiati.js';
import { isIsoDate, todayRome } from '../public/shared/dates.js';

const FIELDS = ['last_name', 'first_name', 'sex', 'birth_date', 'birth_place', 'citizenship', 'residence', 'doc_type', 'doc_number', 'doc_place'];
const bad = (m) => new OpError(400, 'validation', m);
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);
const nowIso = () => new Date().toISOString();

/** Controlla e ripulisce i dati di un ospite. I campi vuoti diventano null (si possono completare dopo). */
export function cleanGuest(input) {
  if (!input || typeof input !== 'object') throw bad('Dati dell’ospite mancanti');
  const out = {};
  const str = (v, max) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw bad('Valore non valido');
    const s = v.trim();
    if (s.length > max) throw bad('Testo troppo lungo');
    return s || null;
  };
  out.last_name = str(input.last_name, 50);
  out.first_name = str(input.first_name, 30);
  if (!out.last_name || !plainName(out.last_name)) throw bad('Scrivi il cognome (in lettere latine, come sul passaporto)');
  if (!out.first_name || !plainName(out.first_name)) throw bad('Scrivi il nome (in lettere latine, come sul passaporto)');
  // Nessun carattere si perde in silenzio: quelli che la Questura non accetta vanno riscritti da chi inserisce i dati.
  for (const [k, label] of [['last_name', 'Il cognome'], ['first_name', 'Il nome']]) {
    const lost = nameTranscription(out[k]).dropped;
    if (lost.length) throw bad(`${label} contiene caratteri che la Questura non accetta (${[...new Set(lost)].join(' ')}): scrivilo in lettere latine, come sul passaporto`);
  }
  out.sex = input.sex === 'M' || input.sex === 'F' ? input.sex : null;
  if (input.sex && !out.sex) throw bad('Sesso non valido');
  out.birth_date = str(input.birth_date, 10);
  if (out.birth_date && (!isIsoDate(out.birth_date) || out.birth_date > todayRome() || out.birth_date < '1900-01-01')) throw bad('Data di nascita non valida');
  for (const k of ['birth_place', 'citizenship', 'residence', 'doc_place']) {
    out[k] = str(input[k], 9);
    if (out[k] && !/^\d{9}$/.test(out[k])) throw bad('Luogo non valido: sceglilo dall’elenco');
  }
  out.doc_type = str(input.doc_type, 5);
  if (out.doc_type && !/^[A-Z0-9]{1,5}$/.test(out.doc_type)) throw bad('Tipo di documento non valido');
  const doc = str(input.doc_number, 30);
  if (doc && docDropped(doc).length) throw bad('Il numero del documento può contenere solo lettere e numeri');
  out.doc_number = doc ? plainDoc(doc).slice(0, 20) || null : null;
  if (doc && !out.doc_number) throw bad('Numero del documento non valido');
  return out;
}

async function getBookingRow(db, id) {
  return db.prepare('SELECT id, house_id, stage, guests, guest_group, check_in, check_out, alloggiati_at FROM bookings WHERE id = ?').bind(id).first();
}

function editable(b) {
  if (!b) throw new OpError(404, 'not_found', 'Prenotazione non trovata.');
  if (b.stage === 'cancellata') throw new OpError(409, 'state', 'La prenotazione è cancellata.');
}

/**
 * Ricalcola "completo" per tutti gli ospiti della prenotazione (il capo deve avere anche il documento)
 * e i conteggi sulla prenotazione (con un nuovo numero di revisione, così gli altri dispositivi li vedono).
 */
export async function refreshComplete(db, bookingId) {
  const list = (await db.prepare(`SELECT id, position, ${FIELDS.join(', ')} FROM guests WHERE booking_id = ? AND deleted = 0 ORDER BY position`).bind(bookingId).all()).results || [];
  const flags = list.map((g, i) => (guestMissing(g, i === 0).length ? 0 : 1));
  const done = flags.filter(Boolean).length;
  await db.batch([
    ...list.map((g, i) => db.prepare('UPDATE guests SET complete = ? WHERE id = ?').bind(flags[i], g.id)),
    db.prepare(`UPDATE bookings SET guests_entered = ?, guests_done = ?, rev = ${REV_NEXT} WHERE id = ?`).bind(list.length, done, bookingId),
    db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'"),
  ]);
  return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first();
}

export async function listGuests(db, bookingId) {
  if (!isId(bookingId)) throw bad('Richiesta non valida');
  const r = await db.prepare(`SELECT g.id, g.booking_id, g.position, g.code, ${FIELDS.map((f) => `g.${f}`).join(', ')}, g.doc_purged_at, g.complete, g.source, g.sent_at, g.version,
      bp.name AS birth_place_name, bp.province AS birth_place_province, bp.kind AS birth_place_kind,
      ci.name AS citizenship_name, re.name AS residence_name, re.kind AS residence_kind, re.province AS residence_province,
      dp.name AS doc_place_name, dt.name AS doc_type_name
    FROM guests g
      LEFT JOIN places bp ON bp.code = g.birth_place
      LEFT JOIN places ci ON ci.code = g.citizenship
      LEFT JOIN places re ON re.code = g.residence
      LEFT JOIN places dp ON dp.code = g.doc_place
      LEFT JOIN doc_types dt ON dt.code = g.doc_type
    WHERE g.booking_id = ? AND g.deleted = 0 ORDER BY g.position`).bind(bookingId).all();
  return r.results || [];
}

async function guestSave(db, user, opId, p) {
  if (!isId(p.bookingId) || !isId(p.id)) throw bad('Richiesta non valida');
  const b = await getBookingRow(db, p.bookingId);
  editable(b);
  const v = cleanGuest(p.guest);
  const at = nowIso();
  const cur = await db.prepare('SELECT * FROM guests WHERE id = ?').bind(p.id).first();
  let main;
  let action;
  // Ospite nuovo già salvato al tentativo prima (la risposta si era persa): è lo stesso, si aggiorna.
  if (cur && p.create === true && cur.created_by === user.email && cur.booking_id === b.id && !cur.deleted) p.version = cur.version;
  if (cur) {
    if (cur.booking_id !== b.id || cur.deleted) throw new OpError(404, 'not_found', 'Ospite non trovato.');
    if (Number(p.version) !== cur.version) throw new OpError(409, 'conflict', 'Questo ospite è stato modificato da un altro dispositivo. Riapri la scheda.');
    const changed = FIELDS.filter((f) => (cur[f] ?? null) !== v[f]);
    if (!changed.length) return { guests: await listGuests(db, b.id) };
    main = db.prepare(`UPDATE guests SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, doc_purged_at = CASE WHEN ? THEN NULL ELSE doc_purged_at END,
        version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`)
      .bind(...FIELDS.map((f) => v[f]), v.doc_number ? 1 : 0, at, user.email, p.id, cur.version);
    action = 'update';
    p.changed = changed;
  } else {
    const count = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxpos FROM guests WHERE booking_id = ? AND deleted = 0').bind(b.id).first();
    if (count.n >= MAX_GUESTS) throw bad(`Massimo ${MAX_GUESTS} ospiti per prenotazione`);
    // Codice interno: il più alto finora + 1 (univoco; se due salvataggi arrivano insieme, uno ritenta).
    main = db.prepare(`INSERT INTO guests (id, booking_id, position, code, ${FIELDS.join(', ')}, source, created_at, created_by, rev)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(code), 100000) + 1 FROM guests), ${FIELDS.map(() => '?').join(', ')}, ?, ?, ?, ${REV_NEXT})`)
      .bind(p.id, b.id, count.maxpos + 1, ...FIELDS.map((f) => v[f]), p.source === 'ospite' ? 'ospite' : 'gestore', at, user.email);
    action = 'create';
  }
  const done = await commit(db, { main, user, opId, entity: 'guest', entityId: p.id, action,
    changes: { prenotazione: b.id, campi: action === 'create' ? 'nuovo ospite' : p.changed.join(', ') } });
  if (!done) throw new OpError(409, 'conflict', 'Salvataggio non riuscito: riapri la scheda e riprova.');
  const record = await refreshComplete(db, b.id);
  return { guests: await listGuests(db, b.id), record };
}

async function guestDelete(db, user, opId, p) {
  if (!isId(p.id)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT id, booking_id FROM guests WHERE id = ? AND deleted = 0').bind(p.id).first();
  if (!cur) throw new OpError(404, 'not_found', 'Ospite non trovato.');
  editable(await getBookingRow(db, cur.booking_id));
  // Un ospite eliminato non conserva i suoi dati personali (resta solo la riga, per il registro).
  const main = db.prepare(`UPDATE guests SET deleted = 1, last_name = '-', first_name = '-', sex = NULL, birth_date = NULL, birth_place = NULL,
      citizenship = NULL, residence = NULL, doc_type = NULL, doc_number = NULL, doc_place = NULL, complete = 0,
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ? AND deleted = 0`)
    .bind(nowIso(), user.email, p.id);
  await commit(db, { main, user, opId, entity: 'guest', entityId: p.id, action: 'delete', changes: { prenotazione: cur.booking_id } });
  // Se erano gli ultimi ospiti del telefono di "chi ha prenotato", il posto si libera per il modulo.
  await db.prepare(`UPDATE bookings SET guest_form_leader_part = NULL WHERE id = ? AND guest_form_leader_part IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM guests g WHERE g.booking_id = bookings.id AND g.deleted = 0 AND g.form_part = bookings.guest_form_leader_part)`)
    .bind(cur.booking_id).run();
  // Le posizioni restano in ordine (0, 1, 2, …) senza buchi.
  const rest = (await db.prepare('SELECT id FROM guests WHERE booking_id = ? AND deleted = 0 ORDER BY position').bind(cur.booking_id).all()).results || [];
  if (rest.length) await db.batch(rest.map((g, i) => db.prepare('UPDATE guests SET position = ? WHERE id = ?').bind(i, g.id)));
  const record = await refreshComplete(db, cur.booking_id);
  return { guests: await listGuests(db, cur.booking_id), record };
}

/** Sceglie chi è il capofamiglia/capogruppo (va in testa all'elenco). */
async function guestLeader(db, user, opId, p) {
  if (!isId(p.id)) throw bad('Richiesta non valida');
  const cur = await db.prepare('SELECT id, booking_id, position FROM guests WHERE id = ? AND deleted = 0').bind(p.id).first();
  if (!cur) throw new OpError(404, 'not_found', 'Ospite non trovato.');
  editable(await getBookingRow(db, cur.booking_id));
  if (cur.position === 0) return { guests: await listGuests(db, cur.booking_id) };
  const list = ((await db.prepare('SELECT id FROM guests WHERE booking_id = ? AND deleted = 0 ORDER BY position').bind(cur.booking_id).all()).results || [])
    .map((g) => g.id).filter((id) => id !== cur.id);
  const order = [cur.id, ...list];
  const main = db.prepare(`UPDATE guests SET version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ?`)
    .bind(nowIso(), user.email, cur.id);
  await commit(db, { main, user, opId, entity: 'guest', entityId: cur.id, action: 'leader', changes: { prenotazione: cur.booking_id } });
  await db.batch(order.map((id, i) => db.prepare('UPDATE guests SET position = ? WHERE id = ?').bind(i, id)));
  const record = await refreshComplete(db, cur.booking_id);
  return { guests: await listGuests(db, cur.booking_id), record };
}

/** Famiglia o gruppo (cambia i tipi delle schedine). */
async function bookingGuestGroup(db, user, opId, p) {
  if (!isId(p.bookingId) || !['famiglia', 'gruppo'].includes(p.group)) throw bad('Richiesta non valida');
  const b = await getBookingRow(db, p.bookingId);
  editable(b);
  if (b.guest_group === p.group) return { guests: await listGuests(db, b.id), record: await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first() };
  const main = db.prepare(`UPDATE bookings SET guest_group = ?, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ?`)
    .bind(p.group, nowIso(), user.email, b.id);
  await commit(db, { main, user, opId, entity: 'booking', entityId: b.id, action: 'update', changes: { guest_group: [b.guest_group, p.group] } });
  return { guests: await listGuests(db, b.id), record: await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first() };
}

export const GUEST_HANDLERS = {
  'guest.save': guestSave,
  'guest.delete': guestDelete,
  'guest.leader': guestLeader,
  'booking.guest_group': bookingGuestGroup,
};
registerOps(GUEST_HANDLERS, { private: true });

/** Cancellazione automatica: ospiti un anno dopo la partenza. Restituisce quanti. */
export async function purgeGuests(db, today = todayRome()) {
  // Link del modulo per gli ospiti: un mese dopo la partenza il codice si cancella (il link smette di esistere).
  await db.prepare(`UPDATE bookings SET guest_form_token = NULL, guest_form_leader_part = NULL
    WHERE guest_form_token IS NOT NULL AND check_out < date(?, '-30 days')`).bind(today).run();
  const r = await db.prepare(`DELETE FROM guests WHERE booking_id IN (SELECT id FROM bookings WHERE check_out < date(?, '-365 days'))`).bind(today).run();
  // Contatori sulla prenotazione allineati (niente "2 di 2 completi" per ospiti che non ci sono più).
  if (r.meta.changes) {
    await db.prepare(`UPDATE bookings SET guests_entered = 0, guests_done = 0 WHERE guests_entered > 0 AND check_out < date(?, '-365 days')
      AND NOT EXISTS (SELECT 1 FROM guests g WHERE g.booking_id = bookings.id)`).bind(today).run();
  }
  return r.meta.changes || 0;
}
