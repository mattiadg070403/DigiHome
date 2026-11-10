-- Calendari di Airbnb e Booking (versione 0.4).
-- Per ogni casa e piattaforma: il link del calendario (iCal) da cui DigiHome legge le prenotazioni.
-- Il link è riservato: lo vede e lo cambia solo l'amministratore.

CREATE TABLE calendars (
  id           TEXT PRIMARY KEY,                -- '<casa>:<piattaforma>'
  house_id     TEXT NOT NULL REFERENCES houses(id),
  channel      TEXT NOT NULL CHECK (channel IN ('airbnb', 'booking')),
  import_url   TEXT CHECK (import_url IS NULL OR length(import_url) BETWEEN 10 AND 1000),
  last_sync_at TEXT,                            -- ultimo tentativo
  last_ok_at   TEXT,                            -- ultimo aggiornamento riuscito
  last_error   TEXT,                            -- errore dell'ultimo tentativo (NULL se è andato bene)
  last_count   INTEGER,                         -- prenotazioni future trovate nell'ultimo aggiornamento
  version      INTEGER NOT NULL DEFAULT 1,
  rev          INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT,
  updated_by   TEXT,
  UNIQUE (house_id, channel)
);

INSERT INTO calendars (id, house_id, channel)
  SELECT h.id || ':' || c.ch, h.id, c.ch
  FROM houses h, (SELECT 'airbnb' AS ch UNION ALL SELECT 'booking') c;

-- Prenotazioni arrivate dal calendario.
ALTER TABLE bookings ADD COLUMN ext_uid TEXT;          -- codice dell'evento nel calendario della piattaforma
ALTER TABLE bookings ADD COLUMN ext_url TEXT;          -- link alla prenotazione su Airbnb (se c'è)
ALTER TABLE bookings ADD COLUMN needs_details INTEGER NOT NULL DEFAULT 0 CHECK (needs_details IN (0, 1));
-- 1 = non è più nel calendario della piattaforma: se è ancora "confermata" va verificata,
-- se è "cancellata" è stata cancellata in automatico (resta l'avviso finché non lo si segna come visto).
ALTER TABLE bookings ADD COLUMN ext_gone INTEGER NOT NULL DEFAULT 0 CHECK (ext_gone IN (0, 1));

CREATE UNIQUE INDEX bookings_ext ON bookings (house_id, channel, ext_uid) WHERE ext_uid IS NOT NULL;
