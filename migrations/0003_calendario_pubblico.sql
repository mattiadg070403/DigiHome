-- Link che DigiHome dà ad Airbnb e Booking (versione 0.4).
-- Per ogni casa e piattaforma: un codice segreto casuale. Il calendario pubblicato con quel codice
-- contiene solo le date occupate dalle prenotazioni degli ALTRI canali (dirette e dell'altra piattaforma),
-- senza nomi né altri dati. Si può rigenerare dalle impostazioni se il link finisce nelle mani sbagliate.

ALTER TABLE calendars ADD COLUMN export_token TEXT;
UPDATE calendars SET export_token = lower(hex(randomblob(24)));
CREATE UNIQUE INDEX calendars_export_token ON calendars (export_token);
