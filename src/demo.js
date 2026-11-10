// Dati inventati per la beta. Nomi e numeri non appartengono a persone reali.
// Disponibile solo se ALLOW_DEMO = "true" (ambiente di prova).

import { addDays, todayRome } from '../public/shared/dates.js';

const REV_NEXT = "(SELECT value FROM meta WHERE key = 'rev') + 1";

export function demoBookings(today = todayRome()) {
  const d = (n) => addDays(today, n);
  const steps = (keys) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, 1])));
  return [
    // Isola Bella
    { house_id: 'isola-bella', channel: 'diretto', guest_name: 'Famiglia Conti (prova)', phone: '+39 000 000 0001', guests: 4,
      check_in: d(-3), check_out: d(2), arrival_time: '16:00', total_cents: 98000, deposit_cents: 30000, deposit_paid: 1,
      security_cents: 20000, security_status: 'incassata', stage: 'in_casa',
      checkin_steps: steps(['ospiti', 'documenti', 'pagamenti', 'contratto', 'contatori', 'alloggiati', 'dms']) },
    { house_id: 'isola-bella', channel: 'airbnb', guest_name: 'Lena Hoffmann (prova)', phone: null, guests: 2,
      check_in: d(2), check_out: d(9), arrival_time: null, total_cents: 112000, security_cents: 0, security_status: 'nessuna', stage: 'confermata', extras: [{ kind: 'tassa_soggiorno', amount_cents: 2800, paid: 0 }] },
    { house_id: 'isola-bella', channel: 'diretto', guest_name: 'Giulia Ferri (prova)', phone: '+39 000 000 0002', guests: 3,
      check_in: d(12), check_out: d(19), total_cents: 126000, deposit_cents: 30000, deposit_paid: 0,
      security_cents: 20000, security_status: 'da_incassare', stage: 'confermata', minors_delegation: 'da_chiedere' },
    // Arrivata dal calendario di Airbnb: nome, persone e telefono da completare.
    { house_id: 'isola-bella', channel: 'airbnb', guest_name: 'Ospite Airbnb (prova)', guests: 1,
      check_in: d(24), check_out: d(28), total_cents: 0, security_cents: 0, security_status: 'nessuna', stage: 'confermata',
      ext_uid: 'prova-1@airbnb.com', needs_details: 1 },
    { house_id: 'isola-bella', channel: 'booking', guest_name: 'Pierre Laurent (prova)', guests: 2,
      check_in: d(-20), check_out: d(-13), total_cents: 84000, security_status: 'nessuna', stage: 'chiusa', review_ok: 1,
      checkin_steps: steps(['ospiti', 'documenti', 'pagamenti', 'contratto', 'alloggiati', 'dms']), checkout_steps: steps(['controllo', 'chiavi']) },
    // Faro Blu
    // Check-in lasciato a metà due giorni fa: mancano Alloggiati e DMS, quindi è oltre le 24 ore.
    { house_id: 'faro-blu', channel: 'diretto', guest_name: 'Coppia Rizzi (prova)', phone: '+39 000 000 0005', guests: 2,
      check_in: d(-2), check_out: d(0), arrival_time: '15:00', total_cents: 36000, deposit_cents: 10000, deposit_paid: 1,
      security_cents: 0, security_status: 'nessuna', stage: 'confermata',
      checkin_steps: steps(['ospiti', 'documenti', 'pagamenti', 'contratto']) },
    { house_id: 'faro-blu', channel: 'booking', guest_name: 'Gruppo Ferraro (prova)', phone: '+39 000 000 0003', guests: 9,
      check_in: d(0), check_out: d(7), arrival_time: '16:30', total_cents: 245000, security_cents: 30000,
      security_status: 'da_incassare', stage: 'confermata', checkin_steps: steps(['ospiti']) },
    { house_id: 'faro-blu', channel: 'diretto', guest_name: 'Marco Bellini (prova)', phone: '+39 000 000 0004', guests: 8,
      check_in: d(9), check_out: d(16), total_cents: 210000, deposit_cents: 50000, deposit_paid: 1,
      security_cents: 30000, security_status: 'da_incassare', stage: 'confermata' },
    { house_id: 'faro-blu', channel: 'airbnb', guest_name: 'Sophie Weber (prova)', guests: 6,
      check_in: d(-9), check_out: d(-2), total_cents: 168000, security_cents: 30000, security_status: 'restituita', stage: 'partita',
      checkin_steps: steps(['ospiti', 'documenti', 'pagamenti', 'contratto', 'alloggiati', 'dms']), checkout_steps: steps(['controllo', 'chiavi', 'cauzione']) },
  ];
}

export function demoTasks(today = todayRome()) {
  return [
    { title: 'Pulizie e cambio biancheria', house_id: 'isola-bella', due_date: addDays(today, 2) },
    { title: 'Chiedere l’orario di arrivo a Lena Hoffmann', house_id: 'isola-bella', due_date: addDays(today, 1) },
    { title: 'Controllo dell’estintore', house_id: 'faro-blu', due_date: addDays(today, -1) },
  ];
}

/** Cancella prenotazioni, note e cose da fare e carica i dati di prova. */
export async function loadDemo(db, user) {
  const at = new Date().toISOString();
  const stmts = [
    db.prepare('DELETE FROM booking_extras'),
    db.prepare('DELETE FROM booking_notes'),
    db.prepare('DELETE FROM tasks'),
    db.prepare('DELETE FROM bookings'),
    db.prepare("DELETE FROM audit_log WHERE entity IN ('booking', 'note', 'task', 'extra')"),
  ];
  for (const b of demoBookings()) {
    const row = {
      id: crypto.randomUUID(), phone: null, arrival_time: null, deposit_cents: 0, deposit_paid: 0, security_cents: 0,
      minors_delegation: 'non_serve', checkin_steps: '{}', checkout_steps: '{}', review_ok: null, ...b,
    };
    const extras = row.extras || [];
    delete row.extras;
    const cols = Object.keys(row);
    stmts.push(db.prepare(`INSERT INTO bookings (${cols.join(', ')}, created_at, created_by, updated_at, updated_by, rev)
      VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ${REV_NEXT})`)
      .bind(...cols.map((c) => row[c]), at, user.email, at, user.email));
    for (const x of extras) {
      stmts.push(db.prepare(`INSERT INTO booking_extras (id, booking_id, kind, label, amount_cents, paid, created_at, created_by, rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})`).bind(crypto.randomUUID(), row.id, x.kind, x.label || null, x.amount_cents, x.paid, at, user.email));
    }
  }
  for (const t of demoTasks()) {
    stmts.push(db.prepare(`INSERT INTO tasks (id, title, house_id, due_date, created_at, created_by, rev)
      VALUES (?, ?, ?, ?, ?, ?, ${REV_NEXT})`).bind(crypto.randomUUID(), t.title, t.house_id, t.due_date, at, user.email));
  }
  stmts.push(db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'"));
  stmts.push(db.prepare(`INSERT INTO audit_log (at, user_email, entity, entity_id, action) VALUES (?, ?, 'demo', 'all', 'load')`)
    .bind(at, user.email));
  await db.batch(stmts);
}
