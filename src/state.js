// Lettura dei dati per l'app: tutto in un'unica lettura coerente.

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
  ]);
  const rows = (i) => results[i].results || [];
  return {
    rev: rows(0)[0]?.rev ?? 0,
    me: { id: user.id, name: user.name, role: user.role, email: user.email },
    houses: rows(1),
    users: rows(2),
    bookings: rows(3),
    notes: rows(4),
    tasks: rows(5),
  };
}

export async function readHistory(db, entityId) {
  const r = await db.prepare(`SELECT a.at, a.action, a.changes, a.entity, COALESCE(u.name, a.user_email) AS who
    FROM audit_log a LEFT JOIN users u ON u.email = a.user_email
    WHERE (a.entity = 'booking' AND a.entity_id = ?)
       OR (a.entity = 'note' AND a.entity_id IN (SELECT id FROM booking_notes WHERE booking_id = ?))
    ORDER BY a.id DESC LIMIT 200`).bind(entityId, entityId).all();
  return (r.results || []).map((x) => ({ ...x, changes: x.changes ? JSON.parse(x.changes) : null }));
}
