-- Modulo online per gli ospiti (versione 0.12, 23/11/2026).
-- Ogni prenotazione può avere un link segreto (codice casuale di 12 caratteri) da mandare all'ospite prima
-- dell'arrivo: l'ospite compila i dati di tutti, che arrivano direttamente nella scheda. Il link funziona solo
-- finché le schedine non sono inviate e al massimo fino al giorno dopo l'arrivo; chi lo apre può solo scrivere,
-- mai leggere i dati già salvati. La pagina vive in un Worker pubblico a parte (cartella ospiti/).

ALTER TABLE bookings ADD COLUMN guest_form_token TEXT;
ALTER TABLE bookings ADD COLUMN guest_form_created_at TEXT;
ALTER TABLE bookings ADD COLUMN guest_form_at TEXT;          -- ultimo invio dei dati da parte dell'ospite
ALTER TABLE bookings ADD COLUMN guest_form_submits INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX bookings_guest_form_token ON bookings (guest_form_token) WHERE guest_form_token IS NOT NULL;
