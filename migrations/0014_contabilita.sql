-- Contabilità (versione 0.10). Regole decise da Mattia (21/11/2026), riassunte in claude/gestionale-contabilita.md:
--  * prezzo del soggiorno = quello pagato dall'ospite per il soggiorno, senza tassa di soggiorno e senza extra chiesti a parte;
--  * cedolare 21% solo sul prezzo del soggiorno (mai su extra e tassa di soggiorno);
--  * commissione dei portali: percentuale fissa per canale, con la data da cui vale (Impostazioni);
--  * Booking versa il netto (senza commissione e ritenuta); Airbnb trattiene la ritenuta dal 2027;
--  * extra chiesti a parte (anche su Airbnb e Booking): ricavo pieno, senza commissione né tasse;
--  * cauzione trattenuta per danni: ricavo (la spesa vera si inserisce tra le spese, tipo "Danni");
--  * tassa di soggiorno sempre a parte: non entra nell'utile, si versa al Comune a fine stagione;
--  * le spese contano nell'anno a cui si riferiscono (periodo), anche se pagate dopo.

-- Prenotazione: come si è pagato e cosa è arrivato davvero dalla piattaforma.
ALTER TABLE bookings ADD COLUMN deposit_method TEXT CHECK (deposit_method IS NULL OR deposit_method IN ('bonifico', 'contanti'));
ALTER TABLE bookings ADD COLUMN balance_method TEXT CHECK (balance_method IS NULL OR balance_method IN ('bonifico', 'contanti'));
ALTER TABLE bookings ADD COLUMN payout_cents INTEGER CHECK (payout_cents IS NULL OR payout_cents BETWEEN 0 AND 100000000);
ALTER TABLE bookings ADD COLUMN payout_at TEXT;

-- Extra: come sono stati pagati.
ALTER TABLE booking_extras ADD COLUMN paid_method TEXT CHECK (paid_method IS NULL OR paid_method IN ('bonifico', 'contanti'));

-- Regole della contabilità per casa (JSON): commissioni per canale con la data da cui valgono,
-- cedolare, obiettivo di utile per anno.
--  Airbnb: 3% + IVA fino al 12/10/2026, 15,5% + IVA dal 13/10/2026; ritenuta trattenuta da Airbnb dal 2027.
--  Booking: 16,16% (dall'esempio di Mattia: 475,86 € su 2.944 €), ritenuta sempre trattenuta da Booking.
ALTER TABLE houses ADD COLUMN accounting TEXT;
UPDATE houses SET accounting = '{"channels":{"airbnb":[{"from":"2000-01-01","pct_bp":300,"vat":true,"withheld":false},{"from":"2026-10-13","pct_bp":1550,"vat":true,"withheld":false},{"from":"2027-01-01","pct_bp":1550,"vat":true,"withheld":true}],"booking":[{"from":"2000-01-01","pct_bp":1616,"vat":false,"withheld":true}]},"cedolare_bp":2100,"goals":{}}';

-- Versamenti: tassa di soggiorno al Comune e cedolare, per casa e per anno.
CREATE TABLE remittances (
  id           TEXT PRIMARY KEY,
  house_id     TEXT NOT NULL REFERENCES houses(id),
  kind         TEXT NOT NULL CHECK (kind IN ('tassa_soggiorno', 'cedolare')),
  year         INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  date         TEXT NOT NULL,
  notes        TEXT CHECK (notes IS NULL OR length(notes) <= 300),
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  version      INTEGER NOT NULL DEFAULT 1,
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   TEXT,
  updated_by   TEXT
);
CREATE INDEX remittances_house_year ON remittances (house_id, year);

-- Spese: si aggiunge il tipo "Danni" (riparazioni o sostituzioni dopo un soggiorno, di solito coperte dalla cauzione).
CREATE TABLE expenses_new (
  id           TEXT PRIMARY KEY,
  house_id     TEXT NOT NULL REFERENCES houses(id),
  category     TEXT NOT NULL CHECK (category IN ('luce', 'acqua_condominio', 'tari', 'pulizie', 'lavanderia', 'danni', 'manutenzione', 'acquisti', 'altro')),
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
CREATE INDEX expenses_booking ON expenses (booking_id);
