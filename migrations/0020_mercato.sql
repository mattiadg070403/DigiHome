-- Dati di mercato con Apify (versione 0.17). Scelte di Mattia (23/11/2026): tutte e due le case, separate;
-- 10 case simili per casa; confronto di prezzi, disponibilità, dotazioni (aria condizionata ecc.) e spese a parte;
-- risultati e suggerimenti nel listino e nel preventivo. Solo dati pubblici degli annunci: niente nomi degli host,
-- niente recensioni. La chiave di Apify è un segreto di Cloudflare (APIFY_TOKEN), mai nel database.

-- Impostazioni per casa (JSON): posizione, raggio, camere, dotazioni della casa, luogo della ricerca.
ALTER TABLE houses ADD COLUMN market_settings TEXT;

-- Case simili trovate su Airbnb (candidati) e scelte (selected = 1, al massimo 10 per casa).
CREATE TABLE market_comps (
  id           TEXT PRIMARY KEY,                    -- casa:annuncio
  house_id     TEXT NOT NULL REFERENCES houses(id),
  listing_id   TEXT NOT NULL CHECK (length(listing_id) BETWEEN 1 AND 30),
  url          TEXT NOT NULL CHECK (url LIKE 'https://www.airbnb.%/rooms/%'),
  title        TEXT CHECK (title IS NULL OR length(title) <= 200),
  capacity     INTEGER,
  bedrooms     INTEGER,
  distance_m   INTEGER,
  rating       REAL,
  reviews      INTEGER,
  amenities    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(amenities)),
  score        REAL,
  selected     INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  found_at     TEXT NOT NULL,
  updated_at   TEXT,
  rev          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (house_id, listing_id)
);

-- Prezzo e disponibilità di ogni casa simile per ogni settimana (ultimo controllo).
CREATE TABLE market_prices (
  house_id       TEXT NOT NULL REFERENCES houses(id),
  listing_id     TEXT NOT NULL,
  week_start     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('libera', 'non_disponibile')),
  week_cents     INTEGER CHECK (week_cents IS NULL OR week_cents BETWEEN 0 AND 100000000),
  cleaning_cents INTEGER CHECK (cleaning_cents IS NULL OR cleaning_cents BETWEEN 0 AND 10000000),
  checked_at     TEXT NOT NULL,
  rev            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (house_id, listing_id, week_start)
);

-- Lavori inviati ad Apify: ricerca delle case simili o prezzi di una settimana. Si avviano pochi alla volta
-- (limiti del piano gratuito) e si controllano a ogni giro dell'orologio di Cloudflare.
CREATE TABLE market_jobs (
  id          TEXT PRIMARY KEY,
  house_id    TEXT NOT NULL REFERENCES houses(id),
  kind        TEXT NOT NULL CHECK (kind IN ('search', 'prices')),
  week_start  TEXT,
  status      TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'error')),
  run_id      TEXT,
  dataset_id  TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  items       INTEGER,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX market_jobs_status ON market_jobs (status, created_at);
