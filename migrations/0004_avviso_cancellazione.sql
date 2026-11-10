-- Avviso dopo aver cancellato NEL GESTIONALE una prenotazione di Airbnb o Booking (versione 0.4.1).
-- Cancellarla qui non la cancella sulla piattaforma: finché non si conferma, compare un avviso importante.
-- Si toglie con "Ho capito", con "Ripristina", oppure da solo quando la prenotazione sparisce anche dal calendario della piattaforma.
ALTER TABLE bookings ADD COLUMN ext_cancel_warn INTEGER NOT NULL DEFAULT 0 CHECK (ext_cancel_warn IN (0, 1));
