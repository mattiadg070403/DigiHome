-- Contratto anche in inglese (versione 0.7): lingua di ogni contratto firmato.
ALTER TABLE contracts ADD COLUMN lang TEXT NOT NULL DEFAULT 'it' CHECK (lang IN ('it', 'en'));

-- Faro Blu: descrizione e orari di silenzio in inglese (modificabili in Impostazioni → Case → Dati del contratto).
UPDATE houses SET contract_info = json_set(contract_info,
    '$.description_en', 'fifth floor, consisting of four rooms, kitchen, bathroom(s) and any appurtenances',
    '$.quiet_hours_en', 'from 2:30 pm to 5:30 pm and from 11:00 pm to 8:00 am')
  WHERE id = 'faro-blu' AND contract_info IS NOT NULL
    AND json_extract(contract_info, '$.description_en') IS NULL;
