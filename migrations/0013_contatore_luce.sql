-- Contatore della luce (versione 0.9): letture all'arrivo e alla partenza, in decimi di kWh.
-- Il contatore mostra tre fasce (A1, A2, A3) che si sommano: si salvano le tre fasce (JSON) e il totale.
-- Con i kWh compresi al giorno (Dati del contratto) il gestionale calcola i kWh in più da incassare.
ALTER TABLE bookings ADD COLUMN meter_start INTEGER CHECK (meter_start IS NULL OR meter_start BETWEEN 0 AND 999999999);
ALTER TABLE bookings ADD COLUMN meter_end INTEGER CHECK (meter_end IS NULL OR meter_end BETWEEN 0 AND 999999999);
ALTER TABLE bookings ADD COLUMN meter_start_bands TEXT;
ALTER TABLE bookings ADD COLUMN meter_end_bands TEXT;
ALTER TABLE bookings ADD COLUMN meter_start_at TEXT;
ALTER TABLE bookings ADD COLUMN meter_end_at TEXT;

-- Gli extra si rifanno per un tipo in più: 'luce' (kWh oltre quelli compresi, calcolato dalle letture).
CREATE TABLE booking_extras_new (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  kind         TEXT NOT NULL CHECK (kind IN ('tassa_soggiorno', 'altro', 'luce')),
  label        TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 80),
  persons      INTEGER CHECK (persons IS NULL OR persons BETWEEN 0 AND 50),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 0 AND 100000000 AND (amount_cents > 0 OR kind = 'tassa_soggiorno')),
  paid         INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  paid_at      TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  version      INTEGER NOT NULL DEFAULT 1,
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   TEXT,
  updated_by   TEXT
);
INSERT INTO booking_extras_new (id, booking_id, kind, label, persons, amount_cents, paid, paid_at, deleted, version, rev, created_at, created_by, updated_at, updated_by)
  SELECT id, booking_id, kind, label, persons, amount_cents, paid, paid_at, deleted, version, rev, created_at, created_by, updated_at, updated_by FROM booking_extras;
DROP TABLE booking_extras;
ALTER TABLE booking_extras_new RENAME TO booking_extras;
CREATE INDEX booking_extras_booking ON booking_extras (booking_id);
