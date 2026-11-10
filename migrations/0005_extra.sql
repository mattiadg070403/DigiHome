-- Extra della prenotazione (versione 0.5): soldi a parte rispetto al prezzo del soggiorno,
-- per esempio la tassa di soggiorno degli ospiti Airbnb e Booking, o un supplemento.
-- Una riga per voce, così più avanti la contabilità le conta per tipo, casa e mese.
CREATE TABLE booking_extras (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  kind         TEXT NOT NULL CHECK (kind IN ('tassa_soggiorno', 'altro')),
  label        TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 80),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
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
CREATE INDEX booking_extras_booking ON booking_extras (booking_id);
