-- Modulo ospiti da più telefoni (versione 0.13, 23/11/2026).
-- Ogni telefono che compila il modulo ha un codice casuale suo ("parte"): i suoi invii si sommano a quelli
-- degli altri e, se rimanda il modulo, sostituiscono solo i dati inviati da quel telefono.
-- Chi ha prenotato (con il documento) può essere uno solo: la sua parte è segnata sulla prenotazione.
ALTER TABLE guests ADD COLUMN form_part TEXT;
CREATE INDEX guests_booking_part ON guests (booking_id, form_part);
ALTER TABLE bookings ADD COLUMN guest_form_leader_part TEXT;
