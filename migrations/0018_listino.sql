-- Listino prezzi (versione 0.14). Scelte di Mattia (23/11/2026): stagione giugno–settembre, prezzi diversi ogni settimana,
-- per ogni settimana il netto che vuole IN TASCA; i prezzi per diretto, Airbnb e Booking si calcolano dalle commissioni
-- della contabilità. Niente stati delle settimane né spunte: solo la base per decidere.

-- Impostazioni del listino per casa (JSON): giorno di inizio della settimana, mesi della stagione, sconti attivi sui
-- portali, netto minimo, regole dei suggerimenti (ultimo minuto, ritmo delle prenotazioni).
ALTER TABLE houses ADD COLUMN pricing TEXT;

-- Netti per settimana: una riga per casa e stagione, settimane in JSON { "AAAA-MM-GG": centesimi }.
CREATE TABLE price_lists (
  id         TEXT PRIMARY KEY,
  house_id   TEXT NOT NULL REFERENCES houses(id),
  year       INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  weeks      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(weeks)),
  version    INTEGER NOT NULL DEFAULT 1,
  rev        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT,
  updated_by TEXT,
  UNIQUE (house_id, year)
);

-- Giorno in cui è arrivata la prenotazione (per il ritmo delle prenotazioni rispetto all'anno scorso).
-- Per quelle già presenti: il giorno di inserimento, ma solo se prima dell'arrivo (le importate dopo il soggiorno
-- non dicono quando sono arrivate).
ALTER TABLE bookings ADD COLUMN booked_on TEXT;
UPDATE bookings SET booked_on = substr(created_at, 1, 10)
  WHERE substr(created_at, 1, 10) <= check_in AND COALESCE(notes, '') <> 'Importata dal vecchio file';
