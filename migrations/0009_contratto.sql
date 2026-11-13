-- Contratto digitale (versione 0.7): solo per le prenotazioni dirette.

-- 1) Dati del contratto per casa, in JSON (modificabili in Impostazioni → Case → Dati del contratto).
--    Qui solo i dati pubblici dell'immobile: i dati personali del locatore (nascita, residenza)
--    NON stanno nel codice, li inserisce l'amministratore dalle impostazioni.
ALTER TABLE houses ADD COLUMN contract_info TEXT;
UPDATE houses SET contract_info = '{"city":"Gallipoli","address":"Via Antonio Rosmini n. 5","description":"piano quinto, composta da quattro vani, cucina, servizi ed eventuali pertinenze","cin":"IT075031C200088528","quiet_hours":"dalle ore 14:30 alle ore 17:30 e dalle ore 23:00 alle ore 08:00","kwh_day":30,"kwh_price_cents":40,"advance_pct":30}'
  WHERE id = 'faro-blu';
UPDATE houses SET contract_info = '{"city":"Gallipoli","advance_pct":30}'
  WHERE id = 'isola-bella';

-- 2) Biancheria compresa di solito (valori proposti nelle nuove prenotazioni):
--    Faro Blu lenzuola sì e asciugamani no, Isola Bella tutte e due.
ALTER TABLE houses ADD COLUMN default_linens INTEGER NOT NULL DEFAULT 1 CHECK (default_linens IN (0, 1));
ALTER TABLE houses ADD COLUMN default_towels INTEGER NOT NULL DEFAULT 0 CHECK (default_towels IN (0, 1));
UPDATE houses SET default_linens = 1, default_towels = 0 WHERE id = 'faro-blu';
UPDATE houses SET default_linens = 1, default_towels = 1 WHERE id = 'isola-bella';

-- 3) Contratti firmati. Il testo (body, in JSON) è ricreato e controllato dal server al momento della firma;
--    hash = impronta SHA-256 di testo, firme, data e ora: se qualcosa cambiasse, l'impronta non tornerebbe.
--    Le firme sono immagini JPEG (data URL) di dimensione limitata.
--    purge_after: data dopo la quale il contratto si cancella da solo (2 anni dopo la partenza).
--    Eliminato (deleted = 1): il contenuto si svuota subito, la riga sparisce dopo 30 giorni.
CREATE TABLE contracts (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  house_id     TEXT NOT NULL REFERENCES houses(id),
  template     INTEGER NOT NULL,             -- versione del modello del contratto
  body         TEXT NOT NULL,                -- testo del contratto (blocchi in JSON)
  guest        TEXT NOT NULL,                -- dati del conduttore (JSON)
  guest_sign   TEXT NOT NULL,
  host_sign    TEXT NOT NULL,
  check_in     TEXT NOT NULL,                -- date e persone al momento della firma
  check_out    TEXT NOT NULL,
  guests       INTEGER NOT NULL,
  signed_at    TEXT NOT NULL,
  signed_by    TEXT NOT NULL,                -- chi ha fatto firmare (email dell'utente)
  signer_name  TEXT,
  hash         TEXT NOT NULL CHECK (length(hash) = 64 OR hash = ''),
  purge_after  TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  version      INTEGER NOT NULL DEFAULT 1,
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT,
  updated_by   TEXT
);
-- Un solo contratto valido per prenotazione.
CREATE UNIQUE INDEX contracts_one_per_booking ON contracts (booking_id) WHERE deleted = 0;
CREATE INDEX contracts_purge ON contracts (purge_after);
