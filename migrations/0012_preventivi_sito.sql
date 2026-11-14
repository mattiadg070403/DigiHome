-- Preventivi: media dello storico su ±7 giorni (i prezzi cambiano di settimana in settimana)
-- e link al sito della casa nel messaggio (per più foto e informazioni).
UPDATE houses SET quote_settings = json_set(quote_settings, '$.window_days', 7)
  WHERE quote_settings IS NOT NULL AND json_extract(quote_settings, '$.window_days') = 20;
UPDATE houses SET quote_settings = json_set(quote_settings, '$.site_url', 'https://faroblugallipoli.it')
  WHERE id = 'faro-blu' AND quote_settings IS NOT NULL AND COALESCE(json_extract(quote_settings, '$.site_url'), '') = '';
UPDATE houses SET quote_settings = json_set(quote_settings, '$.site_url', 'https://isolabellagallipoli.it')
  WHERE id = 'isola-bella' AND quote_settings IS NOT NULL AND COALESCE(json_extract(quote_settings, '$.site_url'), '') = '';
