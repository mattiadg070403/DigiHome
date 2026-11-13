// Lettura dei dati per l'app: tutto in un'unica lettura coerente.

import { contractMeta, publicCalendar, publicHouse } from './ops.js';
import { SYSTEM_EMAIL } from '../public/shared/calendar.js';

export async function readState(db, user) {
  const isAdmin = user.role === 'admin';
  const userCols = isAdmin ? 'id, email, name, role, active, version, rev' : 'id, name, role, active, rev';
  const results = await db.batch([
    db.prepare("SELECT value AS rev FROM meta WHERE key = 'rev'"),
    db.prepare('SELECT * FROM houses ORDER BY sort'),
    db.prepare(`SELECT ${userCols} FROM users ORDER BY name`),
    db.prepare('SELECT * FROM bookings ORDER BY check_in'),
    db.prepare('SELECT * FROM booking_notes WHERE deleted = 0 ORDER BY created_at'),
    db.prepare(`SELECT * FROM tasks WHERE deleted = 0
      AND (done = 0 OR done_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days'))
      ORDER BY COALESCE(due_date, '9999-12-31'), created_at`),
    db.prepare("SELECT * FROM calendars ORDER BY house_id, channel"),
    db.prepare('SELECT * FROM booking_extras WHERE deleted = 0 ORDER BY created_at'),
    db.prepare('SELECT * FROM expenses WHERE deleted = 0 ORDER BY date DESC, created_at DESC'),
    db.prepare('SELECT * FROM deadlines WHERE deleted = 0 ORDER BY due_date'),
    db.prepare(`SELECT id, booking_id, house_id, template, lang, check_in, check_out, guests, signed_at, signer_name, hash, purge_after,
      deleted, version, rev FROM contracts WHERE deleted = 0 ORDER BY signed_at`),
  ]);
  const rows = (i) => results[i].results || [];
  return {
    rev: rows(0)[0]?.rev ?? 0,
    me: { id: user.id, name: user.name, role: user.role, email: user.email },
    houses: rows(1).map((x) => publicHouse(x, isAdmin)),
    users: rows(2),
    bookings: rows(3),
    notes: rows(4),
    tasks: rows(5),
    // Stato dei calendari di Airbnb e Booking: solo per l'amministratore, e mai con il link riservato.
    calendars: isAdmin ? rows(6).map(publicCalendar) : [],
    extras: rows(7),
    expenses: rows(8),
    deadlines: rows(9),
    // Contratti: solo se ci sono e quando sono stati firmati. Testo, dati e firme si scaricano a parte.
    contracts: rows(10).map(contractMeta),
  };
}

export async function readHistory(db, entityId) {
  const r = await db.prepare(`SELECT a.at, a.action, a.changes, a.entity,
      CASE WHEN a.user_email = ? THEN 'Calendario automatico' WHEN a.user_email = 'sistema@digihome.invalid' THEN 'DigiHome (automatico)' ELSE COALESCE(u.name, a.user_email) END AS who
    FROM audit_log a LEFT JOIN users u ON u.email = a.user_email
    WHERE (a.entity = 'booking' AND a.entity_id = ?)
       OR (a.entity = 'note' AND a.entity_id IN (SELECT id FROM booking_notes WHERE booking_id = ?))
       OR (a.entity = 'extra' AND a.entity_id IN (SELECT id FROM booking_extras WHERE booking_id = ?))
       OR (a.entity = 'contract' AND json_extract(a.changes, '$.prenotazione') LIKE ?)
    ORDER BY a.id DESC LIMIT 200`).bind(SYSTEM_EMAIL, entityId, entityId, entityId, `%"${entityId}"%`).all();
  return (r.results || []).map((x) => ({ ...x, changes: x.changes ? JSON.parse(x.changes) : null }));
}

/**
 * Copia completa dei dati, per l'amministratore ("Scarica una copia dei dati").
 * Il link riservato dei calendari non è incluso.
 */
export async function readExport(db) {
  const q = (sql) => db.prepare(sql);
  const r = await db.batch([
    q("SELECT value AS rev FROM meta WHERE key = 'rev'"),
    q('SELECT * FROM houses ORDER BY sort'),
    q('SELECT * FROM users ORDER BY name'),
    q('SELECT * FROM bookings ORDER BY check_in'),
    q('SELECT * FROM booking_notes ORDER BY created_at'),
    q('SELECT * FROM tasks ORDER BY created_at'),
    q('SELECT * FROM calendars ORDER BY house_id, channel'),
    q('SELECT * FROM audit_log ORDER BY id'),
    q('SELECT * FROM booking_extras ORDER BY created_at'),
    q('SELECT * FROM expenses ORDER BY date'),
    q('SELECT * FROM deadlines ORDER BY due_date'),
    q('SELECT * FROM contracts WHERE deleted = 0 ORDER BY signed_at'),
  ]);
  const rows = (i) => r[i].results || [];
  return {
    rev: rows(0)[0]?.rev ?? 0,
    houses: rows(1), users: rows(2), bookings: rows(3), notes: rows(4), tasks: rows(5),
    calendars: rows(6).map((c) => { const { export_token: _t, ...rest } = publicCalendar(c); return rest; }), audit_log: rows(7),
    extras: rows(8), expenses: rows(9), deadlines: rows(10), contracts: rows(11),
  };
}
