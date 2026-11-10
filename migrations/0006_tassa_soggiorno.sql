-- Tassa di soggiorno (versione 0.5).
-- 1) Tariffe per casa, per mese, in centesimi a persona a notte (modificabili in Impostazioni → Case).
--    Partenza: maggio e ottobre 0,50 €, da giugno a settembre 1 €, gli altri mesi niente.
ALTER TABLE houses ADD COLUMN tourist_tax TEXT;
UPDATE houses SET tourist_tax = '{"rates":[0,0,0,0,50,100,100,100,100,50,0,0],"max_nights":null}';

-- 2) Gli extra si rifanno per aggiungere "persone" (quante pagano la tassa) e consentire l'importo 0
--    per la tassa (tutti esenti). La tabella è nuova (0.5): i dati si copiano così come sono.
CREATE TABLE booking_extras_new (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  kind         TEXT NOT NULL CHECK (kind IN ('tassa_soggiorno', 'altro')),
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
INSERT INTO booking_extras_new (id, booking_id, kind, label, amount_cents, paid, paid_at, deleted, version, rev, created_at, created_by, updated_at, updated_by)
  SELECT id, booking_id, kind, label, amount_cents, paid, paid_at, deleted, version, rev, created_at, created_by, updated_at, updated_by FROM booking_extras;
DROP TABLE booking_extras;
ALTER TABLE booking_extras_new RENAME TO booking_extras;
CREATE INDEX booking_extras_booking ON booking_extras (booking_id);
