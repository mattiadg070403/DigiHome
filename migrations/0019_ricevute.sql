-- Ricevuta del saldo per le prenotazioni dirette (versione 0.15). Scelte di Mattia (23/11/2026):
-- facoltativa per casa (spenta di partenza), solo l'importo del saldo all'arrivo, nota della marca da bollo
-- sopra 77,47 €, in italiano e in inglese. Numerazione progressiva per casa e per anno, mai ripetuta.
ALTER TABLE houses ADD COLUMN receipts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (receipts_enabled IN (0, 1));

-- Una ricevuta per prenotazione. "data" conserva quello che c'è scritto (locatore, immobile, ospite, date, pagamento),
-- così la ricevuta si può riscaricare identica anche se poi cambiano i dati della casa o della prenotazione.
CREATE TABLE pay_receipts (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  house_id     TEXT NOT NULL REFERENCES houses(id),
  year         INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  number       INTEGER NOT NULL CHECK (number >= 1),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  data         TEXT NOT NULL CHECK (json_valid(data)),
  issued_at    TEXT NOT NULL,
  issued_by    TEXT NOT NULL,
  rev          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (house_id, year, number)
);
