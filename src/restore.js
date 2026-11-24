// Ripristino della copia dei dati ("Scarica una copia dei dati", GET /api/export) in un database D1 nuovo.
//
// Uso (vedi docs/TECNICO.md, "Backup e ripristino"):
//   node scripts/ripristino.js digihome-produzione-AAAA-MM-GG.json [digihome-…-ricevute-AAAA.json …] > ripristino.sql
//   npx wrangler d1 migrations apply <database nuovo> --remote
//   npx wrangler d1 execute <database nuovo> --remote --file ripristino.sql
//
// Il file SQL non contiene BEGIN/COMMIT (D1 non li accetta) e nessuna istruzione supera i limiti di D1
// (100 KB): i PDF delle ricevute della Questura passano a pezzi da una tabella di appoggio.
// Case e calendari esistono già nel database nuovo (le crea la prima migrazione): si aggiornano, link compresi
// (così quelli già dati ad Airbnb e Booking continuano a funzionare). Le credenziali di Alloggiati non sono nella
// copia: si reinseriscono. Il contatore delle modifiche fa un salto in avanti, così i telefoni e i computer
// ancora aperti riscaricano tutto invece di tenere i dati vecchi.

const ORDER = [
  // tabella della copia → tabella del database (prima i "genitori", poi chi li richiama)
  ['houses', 'houses'],
  ['users', 'users'],
  ['calendars', 'calendars'],
  ['bookings', 'bookings'],
  ['notes', 'booking_notes'],
  ['tasks', 'tasks'],
  ['extras', 'booking_extras'],
  ['expenses', 'expenses'],
  ['deadlines', 'deadlines'],
  ['contracts', 'contracts'],
  ['remittances', 'remittances'],
  ['price_lists', 'price_lists'],
  ['pay_receipts', 'pay_receipts'],
  ['guests', 'guests'],
  ['market_comps', 'market_comps'],
  ['market_prices', 'market_prices'],
  ['audit_log', 'audit_log'],
];

// Campi della copia che non sono colonne (le copie fino alla 0.19 avevano i calendari nella forma "pubblica").
const NOT_COLUMNS = { calendars: new Set(['connected', 'url_hint']) };
const REV_JUMP = 1_000_000;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const MAX_STMT = 90_000; // sotto il limite di D1 (100 KB per istruzione)
const CHUNK = 80_000; // caratteri esadecimali per pezzo di PDF

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Numero non valido nella copia');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return lit(JSON.stringify(v));
  return `'${String(v).replaceAll("'", "''")}'`;
}

function insert(table, row, skip) {
  const cols = Object.keys(row).filter((c) => !(skip && skip.has(c)));
  for (const c of cols) if (!IDENT.test(c)) throw new Error(`Colonna non valida nella copia: ${c}`);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => lit(row[c])).join(', ')}) `
    + `ON CONFLICT DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')};`;
  if (sql.length > MAX_STMT) throw new Error(`Riga troppo grande per D1 in ${table} (${row.id || ''})`);
  return sql;
}

function base64ToHex(b64) {
  const bin = atob(String(b64 || ''));
  let hex = '';
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return hex.toUpperCase();
}

/**
 * Testo SQL che ricostruisce i dati della copia (file principale + file delle ricevute della Questura).
 * Lancia un errore se la copia non è valida o se manca il file delle ricevute di un anno.
 */
export function buildRestoreSql(data, receiptFiles = []) {
  if (!data || data.app !== 'DigiHome' || data.kind === 'ricevute' || !Array.isArray(data.bookings) || !Array.isArray(data.houses)) {
    throw new Error('Non è una copia dei dati di DigiHome');
  }
  const receiptsIn = [];
  for (const f of receiptFiles) {
    if (!f || f.app !== 'DigiHome' || f.kind !== 'ricevute' || !Array.isArray(f.alloggiati_receipts)) throw new Error('Un file delle ricevute non è valido');
    for (const r of f.alloggiati_receipts) receiptsIn.push({ ...r, pdf_hex: r.pdf_hex || base64ToHex(r.pdf_base64) });
  }
  const years = new Set(receiptFiles.map((f) => f.year));
  const missing = (data.receipt_years || []).filter((y) => !years.has(y));
  if (missing.length) throw new Error(`Mancano i file delle ricevute della Questura del ${missing.join(', ')}`);
  const out = [
    '-- Ripristino della copia di DigiHome',
    `-- copia del ${data.exported_at || '?'} · versione ${data.version || '?'} · ambiente ${data.env || '?'}`,
    'PRAGMA defer_foreign_keys = ON;',
  ];
  const counts = {};
  for (const [key, table] of ORDER) {
    const rows = data[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error(`Parte non valida nella copia: ${key}`);
    counts[table] = rows.length;
    for (const row of rows) out.push(insert(table, row, NOT_COLUMNS[key]));
  }
  // Ricevute della Questura (PDF): a pezzi in una tabella di appoggio, poi ricomposte con unhex().
  const receipts = [...(data.alloggiati_receipts || []), ...receiptsIn];
  if (receipts.length) {
    out.push('CREATE TABLE IF NOT EXISTS _ripristino_pezzi (rid TEXT NOT NULL, seq INTEGER NOT NULL, hex TEXT NOT NULL, PRIMARY KEY (rid, seq));');
    for (const r of receipts) {
      const hex = String(r.pdf_hex || '');
      if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length % 2) throw new Error(`Ricevuta non valida nella copia (${r.id})`);
      out.push(`DELETE FROM _ripristino_pezzi WHERE rid = ${lit(r.id)};`);
      let seq = 0;
      for (let i = 0; i < hex.length || seq === 0; i += CHUNK, seq++) {
        out.push(`INSERT INTO _ripristino_pezzi (rid, seq, hex) VALUES (${lit(r.id)}, ${seq}, '${hex.slice(i, i + CHUNK)}');`);
      }
      // Pezzi in ordine, uno dopo l'altro (senza group_concat, che non garantisce l'ordine).
      const joined = Array.from({ length: seq }, (_, k) => `(SELECT hex FROM _ripristino_pezzi WHERE rid = ${lit(r.id)} AND seq = ${k})`).join(' || ');
      out.push(`INSERT INTO alloggiati_receipts (id, house_id, date, pdf, size, sha256, fetched_at, purge_after) `
        + `VALUES (${lit(r.id)}, ${lit(r.house_id)}, ${lit(r.date)}, unhex(${joined}), ${lit(r.size)}, ${lit(r.sha256)}, ${lit(r.fetched_at)}, ${lit(r.purge_after)}) `
        + 'ON CONFLICT DO UPDATE SET pdf = excluded.pdf, size = excluded.size, sha256 = excluded.sha256, fetched_at = excluded.fetched_at, purge_after = excluded.purge_after;');
    }
    out.push('DROP TABLE _ripristino_pezzi;');
    counts.alloggiati_receipts = receipts.length;
  }
  // Contatore delle modifiche: un salto in avanti, oltre qualsiasi valore già visto da un dispositivo, così chi ha
  // l'app aperta riceve lo stato intero nuovo (altrimenti scarterebbe le risposte come "più vecchie").
  const rev = Number.isInteger(data.rev) ? data.rev : 0;
  out.push(`UPDATE meta SET value = max(value, ${rev}) + ${REV_JUMP} WHERE key = 'rev';`);
  return { sql: `${out.join('\n')}\n`, counts };
}
