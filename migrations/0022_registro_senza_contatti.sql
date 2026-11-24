-- Registro delle modifiche senza dati personali di contatto né testi liberi (verifica del 24/11/2026):
-- nome, telefono, email e note degli ospiti (e i testi di note e cose da fare) restano solo come "modificato".
-- Le righe nuove li scrivono già così (src/ops.js, auditSafe).
UPDATE audit_log SET changes = json_set(changes, '$.guest_name', 'modificato')
  WHERE changes IS NOT NULL AND json_valid(changes) AND json_type(changes, '$.guest_name') IS NOT NULL AND json_type(changes, '$.guest_name') <> 'null';
UPDATE audit_log SET changes = json_set(changes, '$.phone', 'modificato')
  WHERE changes IS NOT NULL AND json_valid(changes) AND json_type(changes, '$.phone') IS NOT NULL AND json_type(changes, '$.phone') <> 'null';
UPDATE audit_log SET changes = json_set(changes, '$.email', 'modificato')
  WHERE changes IS NOT NULL AND json_valid(changes) AND json_type(changes, '$.email') IS NOT NULL AND json_type(changes, '$.email') <> 'null'
  AND entity <> 'user';
UPDATE audit_log SET changes = json_set(changes, '$.notes', 'modificato')
  WHERE changes IS NOT NULL AND json_valid(changes) AND json_type(changes, '$.notes') IS NOT NULL AND json_type(changes, '$.notes') <> 'null';
UPDATE audit_log SET changes = json_set(changes, '$.text', 'modificato')
  WHERE changes IS NOT NULL AND json_valid(changes) AND json_type(changes, '$.text') IS NOT NULL AND json_type(changes, '$.text') <> 'null';
