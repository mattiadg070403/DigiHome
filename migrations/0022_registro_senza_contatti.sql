-- Registro delle modifiche senza dati personali di contatto né testi liberi (verifica del 24/11/2026):
-- nome, telefono, email e note degli ospiti (e i testi di note e cose da fare) restano solo come "modificato".
-- Le righe nuove li scrivono già così (src/ops.js, auditSafe).
-- CASE: le funzioni JSON si chiamano solo su testo JSON valido (SQLite non garantisce l'ordine dei controlli in AND).
UPDATE audit_log SET changes = json_set(changes, '$.guest_name', 'modificato')
  WHERE CASE WHEN json_valid(changes) THEN COALESCE(json_type(changes, '$.guest_name'), 'null') <> 'null' ELSE 0 END;
UPDATE audit_log SET changes = json_set(changes, '$.phone', 'modificato')
  WHERE CASE WHEN json_valid(changes) THEN COALESCE(json_type(changes, '$.phone'), 'null') <> 'null' ELSE 0 END;
UPDATE audit_log SET changes = json_set(changes, '$.email', 'modificato')
  WHERE entity <> 'user' AND CASE WHEN json_valid(changes) THEN COALESCE(json_type(changes, '$.email'), 'null') <> 'null' ELSE 0 END;
UPDATE audit_log SET changes = json_set(changes, '$.notes', 'modificato')
  WHERE CASE WHEN json_valid(changes) THEN COALESCE(json_type(changes, '$.notes'), 'null') <> 'null' ELSE 0 END;
UPDATE audit_log SET changes = json_set(changes, '$.text', 'modificato')
  WHERE CASE WHEN json_valid(changes) THEN COALESCE(json_type(changes, '$.text'), 'null') <> 'null' ELSE 0 END;
