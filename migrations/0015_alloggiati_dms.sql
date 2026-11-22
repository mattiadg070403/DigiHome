-- Ospiti, Alloggiati Web e DMS Puglia (versione 0.11, 22/11/2026).
--  * I dati degli ospiti si scrivono una volta sola (nella scheda della prenotazione) e servono per:
--    schedine Alloggiati Web (Polizia di Stato) e file del DMS Puglia (SPOT Online, "Carica movimentazione").
--  * Le schedine si inviano dal gestionale con il servizio web ufficiale (utente, password e WsKey della casa).
--    Le credenziali stanno cifrate in house_secrets e non escono mai dal server (né nello stato, né nella copia dei dati).
--  * La ricevuta del giorno si scarica da sola e si conserva 5 anni; i dati dei documenti si cancellano
--    appena c'è la ricevuta; gli ospiti si cancellano un anno dopo la partenza.

CREATE TABLE guests (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  position     INTEGER NOT NULL CHECK (position BETWEEN 0 AND 49),   -- 0 = capofamiglia, capogruppo o ospite singolo
  code         INTEGER NOT NULL UNIQUE,                               -- codice interno dell'ospite (DMS: codiceclientesr)
  last_name    TEXT NOT NULL CHECK (length(last_name) BETWEEN 1 AND 50),
  first_name   TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 30),
  sex          TEXT CHECK (sex IS NULL OR sex IN ('M', 'F')),
  birth_date   TEXT,
  birth_place  TEXT CHECK (birth_place IS NULL OR length(birth_place) = 9),   -- comune italiano o stato estero
  citizenship  TEXT CHECK (citizenship IS NULL OR length(citizenship) = 9),
  residence    TEXT CHECK (residence IS NULL OR length(residence) = 9),       -- comune italiano o stato estero
  doc_type     TEXT CHECK (doc_type IS NULL OR length(doc_type) BETWEEN 1 AND 5),
  doc_number   TEXT CHECK (doc_number IS NULL OR length(doc_number) BETWEEN 1 AND 20),
  doc_place    TEXT CHECK (doc_place IS NULL OR length(doc_place) = 9),
  doc_purged_at TEXT,
  complete     INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  source       TEXT NOT NULL DEFAULT 'gestore' CHECK (source IN ('gestore', 'ospite')),
  sent_at      TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  version      INTEGER NOT NULL DEFAULT 1,
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   TEXT,
  updated_by   TEXT
);
CREATE INDEX guests_booking ON guests (booking_id, position);

-- Prenotazione: famiglia o gruppo (per i tipi delle schedine) ed esito dell'invio ad Alloggiati.
ALTER TABLE bookings ADD COLUMN guest_group TEXT NOT NULL DEFAULT 'famiglia' CHECK (guest_group IN ('famiglia', 'gruppo'));
ALTER TABLE bookings ADD COLUMN alloggiati_at TEXT;
ALTER TABLE bookings ADD COLUMN alloggiati_by TEXT;
ALTER TABLE bookings ADD COLUMN alloggiati_count INTEGER;
ALTER TABLE bookings ADD COLUMN alloggiati_error TEXT;
-- Quanti ospiti sono stati inseriti e quanti sono completi (per elenchi e avvisi, senza scaricare i dati).
ALTER TABLE bookings ADD COLUMN guests_entered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN guests_done INTEGER NOT NULL DEFAULT 0;

-- Stato del collegamento con Alloggiati (JSON, senza credenziali) e impostazioni del DMS (camere, posti letto, ultimo giorno caricato).
ALTER TABLE houses ADD COLUMN alloggiati_status TEXT;
ALTER TABLE houses ADD COLUMN dms_settings TEXT;

-- Credenziali cifrate (AES-GCM, chiave derivata dal segreto Cloudflare CHIAVE_CREDENZIALI). Mai lette dallo stato.
CREATE TABLE house_secrets (
  house_id    TEXT PRIMARY KEY REFERENCES houses(id),
  alloggiati  TEXT,
  set_at      TEXT,
  set_by      TEXT
);

-- Ricevute di Alloggiati Web (PDF firmato della Polizia), una per casa e giorno di invio. Conservate 5 anni.
CREATE TABLE alloggiati_receipts (
  id          TEXT PRIMARY KEY,
  house_id    TEXT NOT NULL REFERENCES houses(id),
  date        TEXT NOT NULL,
  pdf         BLOB NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  UNIQUE (house_id, date)
);

-- Tabelle ufficiali di Alloggiati Web (luoghi e tipi di documento), scaricate dal servizio web.
CREATE TABLE places (
  code     TEXT PRIMARY KEY CHECK (length(code) = 9),
  name     TEXT NOT NULL,
  province TEXT,
  kind     TEXT NOT NULL CHECK (kind IN ('C', 'S')),   -- C = comune italiano, S = stato
  active   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE INDEX places_name ON places (name);
CREATE TABLE doc_types (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
