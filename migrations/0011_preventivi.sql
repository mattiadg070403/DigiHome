-- Preventivi (versione 0.8): impostazioni per casa, in JSON (Impostazioni → Case → Preventivi).
-- Validità 7 giorni, cauzione 250 €, minimo 5 notti a luglio e agosto (solo avviso),
-- sconti per soggiorni lunghi e ultimo minuto, aumento per richieste molto anticipate,
-- extra: garage 10 € a persona per tutto il soggiorno (in tutte e due le case).
-- I preventivi NON si salvano: niente tabella.
ALTER TABLE houses ADD COLUMN quote_settings TEXT;
UPDATE houses SET quote_settings = '{"validity_days":7,"security_cents":25000,"min_nights":[0,0,0,0,0,0,5,5,0,0,0,0],"window_days":20,"long_stay":[{"nights":7,"pct":5},{"nights":14,"pct":10}],"early":{"days":120,"pct":5},"last_minute":{"days":14,"pct":10},"extras":[{"id":"garage","label":"Garage","label_en":"Garage","price_cents":1000,"unit":"persona"}],"note":"","note_en":""}';
