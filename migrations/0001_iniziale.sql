-- Struttura iniziale del gestionale (beta 0.1)
-- Importi in centesimi. Date di soggiorno 'AAAA-MM-GG' (Italia).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO meta (key, value) VALUES ('rev', 0);

CREATE TABLE houses (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  short_name    TEXT NOT NULL,
  color         TEXT NOT NULL,
  color_dark    TEXT NOT NULL,
  color_soft    TEXT NOT NULL,
  logo          TEXT,
  max_guests    INTEGER NOT NULL CHECK (max_guests BETWEEN 1 AND 50),
  checkin_time  TEXT NOT NULL DEFAULT '14:00',
  checkout_time TEXT NOT NULL DEFAULT '10:00',
  sort          INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  rev           INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT,
  updated_by    TEXT
);

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'collaboratore')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version    INTEGER NOT NULL DEFAULT 1,
  rev        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE bookings (
  id                      TEXT PRIMARY KEY,
  house_id                TEXT NOT NULL REFERENCES houses(id),
  channel                 TEXT NOT NULL CHECK (channel IN ('diretto', 'airbnb', 'booking')),
  guest_name              TEXT NOT NULL CHECK (length(guest_name) BETWEEN 1 AND 120),
  phone                   TEXT,
  email                   TEXT,
  guests                  INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 50),
  check_in                TEXT NOT NULL,
  check_out               TEXT NOT NULL,
  arrival_time            TEXT,
  total_cents             INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  deposit_cents           INTEGER NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  deposit_paid            INTEGER NOT NULL DEFAULT 0 CHECK (deposit_paid IN (0, 1)),
  security_cents          INTEGER NOT NULL DEFAULT 0 CHECK (security_cents >= 0),
  security_status         TEXT NOT NULL DEFAULT 'da_incassare'
                            CHECK (security_status IN ('nessuna', 'da_incassare', 'incassata', 'restituita', 'trattenuta')),
  security_withheld_cents INTEGER NOT NULL DEFAULT 0 CHECK (security_withheld_cents >= 0),
  security_note           TEXT,
  linens                  INTEGER NOT NULL DEFAULT 1 CHECK (linens IN (0, 1)),
  towels                  INTEGER NOT NULL DEFAULT 0 CHECK (towels IN (0, 1)),
  minors_delegation       TEXT NOT NULL DEFAULT 'non_serve'
                            CHECK (minors_delegation IN ('non_serve', 'da_chiedere', 'ricevuta')),
  stage                   TEXT NOT NULL DEFAULT 'confermata'
                            CHECK (stage IN ('confermata', 'in_casa', 'partita', 'chiusa', 'cancellata')),
  prev_stage              TEXT,
  checkin_steps           TEXT NOT NULL DEFAULT '{}',
  checkout_steps          TEXT NOT NULL DEFAULT '{}',
  review_ok               INTEGER CHECK (review_ok IN (0, 1)),
  notes                   TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,
  rev                     INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  created_by              TEXT NOT NULL,
  updated_at              TEXT,
  updated_by              TEXT,
  CHECK (check_out > check_in)
);
CREATE INDEX bookings_house_dates ON bookings (house_id, check_in, check_out);

CREATE TABLE booking_notes (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  text       TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  rev        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX booking_notes_booking ON booking_notes (booking_id);

CREATE TABLE tasks (
  id         TEXT PRIMARY KEY,
  house_id   TEXT REFERENCES houses(id),
  booking_id TEXT REFERENCES bookings(id),
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  due_date   TEXT,
  assignee   TEXT REFERENCES users(id),
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  done_at    TEXT,
  done_by    TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  version    INTEGER NOT NULL DEFAULT 1,
  rev        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  user_email TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  changes   TEXT
);
CREATE INDEX audit_log_entity ON audit_log (entity, entity_id);

CREATE TABLE ops (
  op_id      TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  user_email TEXT NOT NULL,
  result     TEXT NOT NULL
);

-- Le due case (dati dei siti, nessun dato personale)
INSERT INTO houses (id, name, short_name, color, color_dark, color_soft, logo, max_guests, checkin_time, checkout_time, sort)
VALUES
  ('isola-bella', 'Isola Bella', 'Isola Bella', '#2D6A64', '#1F4D48', '#EAF3F1', NULL, 6, '14:00', '10:00', 1),
  ('faro-blu', 'Faro Blu', 'Faro Blu', '#1B4F8F', '#0F2E55', '#EEF4FA', NULL, 10, '14:00', '10:00', 2);
