-- Spese: si aggiunge la luce (c'è la bolletta della luce; il gas invece no). Indicazione di Mattia, 11/11.
-- In SQLite il controllo dei valori ammessi non si cambia direttamente: si rifà la tabella copiando i dati.
CREATE TABLE expenses_new (
  id           TEXT PRIMARY KEY,
  house_id     TEXT NOT NULL REFERENCES houses(id),
  category     TEXT NOT NULL CHECK (category IN ('luce', 'acqua_condominio', 'tari', 'pulizie', 'lavanderia', 'manutenzione', 'acquisti', 'altro')),
  label        TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 120),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 0 AND 100000000),
  date         TEXT NOT NULL,
  period_from  TEXT,
  period_to    TEXT,
  due_date     TEXT,
  paid         INTEGER NOT NULL DEFAULT 1 CHECK (paid IN (0, 1)),
  paid_at      TEXT,
  booking_id   TEXT REFERENCES bookings(id),
  notes        TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  attach_ref   TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  version      INTEGER NOT NULL DEFAULT 1,
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   TEXT,
  updated_by   TEXT
);
INSERT INTO expenses_new SELECT id, house_id, category, label, amount_cents, date, period_from, period_to, due_date, paid, paid_at,
  booking_id, notes, attach_ref, deleted, version, rev, created_at, created_by, updated_at, updated_by FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX expenses_house_date ON expenses (house_id, date);
