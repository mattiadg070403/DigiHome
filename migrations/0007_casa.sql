-- Archivio della casa (versione 0.6): spese e scadenze, per casa e per anno.

-- Spese: acqua e condominio (insieme), TARI, pulizie, lavanderia, manutenzione, acquisti, altro.
-- Niente luce e gas: nelle case non ci sono bollette separate (indicazione di Mattia, 11/11).
-- Solo i dati (importo, periodo, note): i documenti restano fuori dal gestionale; attach_ref è
-- riservato per gli allegati, se si aggiungeranno più avanti senza rifare la tabella.
CREATE TABLE expenses (
  id           TEXT PRIMARY KEY,
  house_id     TEXT NOT NULL REFERENCES houses(id),
  category     TEXT NOT NULL CHECK (category IN ('acqua_condominio', 'tari', 'pulizie', 'lavanderia', 'manutenzione', 'acquisti', 'altro')),
  label        TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 120),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 0 AND 100000000),
  date         TEXT NOT NULL,                 -- data della spesa o della bolletta (AAAA-MM-GG)
  period_from  TEXT,                          -- periodo di riferimento (bollette, TARI): facoltativo
  period_to    TEXT,
  due_date     TEXT,                          -- scadenza di pagamento, se non ancora pagata
  paid         INTEGER NOT NULL DEFAULT 1 CHECK (paid IN (0, 1)),
  paid_at      TEXT,
  booking_id   TEXT REFERENCES bookings(id),  -- spesa legata a un soggiorno (pulizie, lavanderia)
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
CREATE INDEX expenses_house_date ON expenses (house_id, date);

-- Scadenze: rinnovi, assicurazione, estintori, versamenti, ecc. Visibili a tutti.
-- Le ricorrenti, una volta fatte, si spostano da sole alla data successiva.
CREATE TABLE deadlines (
  id           TEXT PRIMARY KEY,
  house_id     TEXT REFERENCES houses(id),    -- NULL = tutte e due le case
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  due_date     TEXT NOT NULL,
  repeat       TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'monthly', 'quarterly', 'yearly')),
  notice_days  INTEGER NOT NULL DEFAULT 30 CHECK (notice_days BETWEEN 0 AND 365),
  notes        TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  last_done_at TEXT,                          -- ultima volta che è stata segnata fatta
  done         INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),   -- solo per quelle senza ripetizione
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  version      INTEGER NOT NULL DEFAULT 1,
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   TEXT,
  updated_by   TEXT
);
CREATE INDEX deadlines_due ON deadlines (due_date);
