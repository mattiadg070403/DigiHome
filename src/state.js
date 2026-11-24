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
    db.prepare('SELECT * FROM remittances WHERE deleted = 0 ORDER BY date'),
    db.prepare('SELECT id, house_id, date, size, fetched_at, purge_after FROM alloggiati_receipts ORDER BY date DESC'),
    db.prepare('SELECT * FROM price_lists ORDER BY house_id, year'),
    db.prepare('SELECT * FROM pay_receipts ORDER BY issued_at'),
    db.prepare('SELECT * FROM market_comps ORDER BY house_id, selected DESC, score'),
    db.prepare('SELECT house_id, listing_id, week_start, status, week_cents, cleaning_cents, checked_at, rev FROM market_prices ORDER BY house_id, week_start'),
    db.prepare('SELECT id, house_id, kind, week_start, status, error, items, created_at, finished_at FROM market_jobs ORDER BY created_at DESC LIMIT 60'),
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
    // Versamenti di tassa di soggiorno e cedolare (contabilità: la vedono tutti, decisione di Mattia 21/11).
    remittances: rows(11),
    // Ricevute di Alloggiati Web: solo data e dimensione; il PDF si scarica a parte.
    receipts: rows(12),
    // Listino prezzi: netti per settimana (lo vedono tutti, lo cambia solo l'amministratore).
    prices: rows(13),
    // Ricevute del saldo: contengono i dati del locatore, solo per l'amministratore.
    payReceipts: rows(14),
    // Mercato: case simili (dati pubblici degli annunci), prezzi per settimana e ultimi lavori su Apify.
    marketComps: rows(15),
    marketPrices: rows(16),
    marketJobs: isAdmin ? rows(17) : [],
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
    q('SELECT * FROM remittances ORDER BY date'),
    q('SELECT * FROM price_lists ORDER BY house_id, year'),
    q('SELECT * FROM pay_receipts ORDER BY issued_at'),
  ]);
  const rows = (i) => r[i].results || [];
  return {
    rev: rows(0)[0]?.rev ?? 0,
    houses: rows(1), users: rows(2), bookings: rows(3), notes: rows(4), tasks: rows(5),
    calendars: rows(6).map((c) => { const { export_token: _t, ...rest } = publicCalendar(c); return rest; }), audit_log: rows(7),
    extras: rows(8), expenses: rows(9), deadlines: rows(10), contracts: rows(11), remittances: rows(12), price_lists: rows(13), pay_receipts: rows(14),
  };
}
