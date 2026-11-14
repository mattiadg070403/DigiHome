// Lettura di fogli Excel (.xlsx) e CSV sul dispositivo, senza librerie esterne e senza inviare il file a nessuno.
// Si leggono solo i valori delle celle (niente formule, macro o collegamenti esterni).

const MAX_FILE = 15 * 1024 * 1024;      // file fino a 15 MB
const MAX_PART = 60 * 1024 * 1024;      // nessuna parte decompressa oltre 60 MB (contro i file "bomba")
const MAX_ROWS = 20000;

const td = new TextDecoder('utf-8');

/* ------------------------------ ZIP ------------------------------ */

function u16(b, i) { return b[i] | (b[i + 1] << 8); }
function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

/** Elenco dei file nello zip: { name: { method, comp, size, offset } }. */
function zipEntries(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Il file non è un foglio Excel valido (.xlsx).');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out = {};
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('File Excel rovinato.');
    const method = u16(b, p + 10);
    const comp = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nl = u16(b, p + 28);
    const el = u16(b, p + 30);
    const cl = u16(b, p + 32);
    const offset = u32(b, p + 42);
    const name = td.decode(b.subarray(p + 46, p + 46 + nl));
    out[name] = { method, comp, size, offset };
    p += 46 + nl + el + cl;
  }
  return out;
}

async function zipRead(b, entries, name) {
  const e = entries[name];
  if (!e) return null;
  if (e.size > MAX_PART) throw new Error('File troppo grande.');
  const p = e.offset;
  if (u32(b, p) !== 0x04034b50) throw new Error('File Excel rovinato.');
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  const data = b.subarray(start, start + e.comp);
  if (e.method === 0) return td.decode(data);
  if (e.method !== 8) throw new Error('Formato di compressione non supportato.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  if (buf.length > MAX_PART) throw new Error('File troppo grande.');
  return td.decode(buf);
}

/* ------------------------------ XML ------------------------------ */

function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  });
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
};

/** Testo di un elemento con "pezzi" (<t>…</t>, anche formattati). */
function textOf(xml) {
  let s = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += unescapeXml(m[1]);
  return s;
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref || '');
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    if (rows.length >= MAX_ROWS) break;
    const body = rm[2] || '';
    const rIdx = Number(attr(rm[1] || '', 'r')) - 1;
    const row = [];
    let next = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cm[1];
      const inner = cm[2] || '';
      const ci = colIndex(attr(tag, 'r'));
      const idx = ci >= 0 ? ci : next;
      next = idx + 1;
      if (idx > 200) continue;
      const t = attr(tag, 't');
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      let value = null;
      if (t === 's') value = v ? shared[Number(v[1])] ?? '' : '';
      else if (t === 'inlineStr') value = textOf(inner);
      else if (t === 'str' || t === 'e') value = v ? unescapeXml(v[1]) : '';
      else if (t === 'b') value = v ? v[1] === '1' : null;
      else if (v) { const n = Number(v[1]); value = Number.isFinite(n) ? n : unescapeXml(v[1]); }
      row[idx] = value;
    }
    const at = Number.isInteger(rIdx) && rIdx >= rows.length ? rIdx : rows.length;
    while (rows.length < at && rows.length < MAX_ROWS) rows.push([]);
    rows.push(Array.from(row, (x) => (x === undefined ? null : x)));
  }
  return rows;
}

async function readXlsx(bytes) {
  const entries = zipEntries(bytes);
  const wb = await zipRead(bytes, entries, 'xl/workbook.xml');
  if (!wb) throw new Error('Il file non è un foglio Excel valido (.xlsx).');
  const rels = (await zipRead(bytes, entries, 'xl/_rels/workbook.xml.rels')) || '';
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    let t = attr(m[0], 'Target') || '';
    t = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
    target[id] = t.replace(/\/\.\//g, '/');
  }
  const sharedXml = (await zipRead(bytes, entries, 'xl/sharedStrings.xml')) || '';
  const shared = [];
  for (const m of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') || `Foglio ${sheets.length + 1}`;
    const rid = attr(m[0], 'r:id');
    const path = target[rid] || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = await zipRead(bytes, entries, path);
    if (xml) sheets.push({ name, rows: sheetRows(xml, shared) });
  }
  if (!sheets.length) throw new Error('Nel file non ci sono fogli da leggere.');
  return sheets;
}

/* ------------------------------ CSV ------------------------------ */

export function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const first = s.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const sep = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length >= MAX_ROWS) break;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => (c.trim() === '' ? null : c.trim())));
}

/**
 * Legge un file .xlsx o .csv scelto sul dispositivo.
 * Restituisce [{ name, rows: [[cella, …], …] }] (celle: testo, numero, vero/falso o null).
 */
export async function readSpreadsheet(file) {
  if (!file) throw new Error('Scegli un file.');
  if (file.size > MAX_FILE) throw new Error('File troppo grande (massimo 15 MB).');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return readXlsx(bytes);
  if (/\.xls$/i.test(file.name || '')) throw new Error('Questo è il vecchio formato Excel (.xls): aprilo in Excel e salvalo come .xlsx, poi riprova.');
  return [{ name: file.name || 'CSV', rows: parseCsv(td.decode(bytes)) }];
}
