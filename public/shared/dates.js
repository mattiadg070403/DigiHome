// Date di calendario 'AAAA-MM-GG', sempre riferite all'Italia.
// Usato sia dall'app sia dal server.

const TZ = 'Europe/Rome';
const DAY_MS = 86400000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio',
  'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const MONTHS_SHORT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const DAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const DAYS_SHORT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];

export function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Oggi in Italia, come 'AAAA-MM-GG'. */
export function todayRome(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function toUtc(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(s, n) {
  return fromUtc(toUtc(s) + n * DAY_MS);
}

/** Giorni da a a b (b - a). */
export function daysBetween(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export function nights(checkIn, checkOut) {
  return daysBetween(checkIn, checkOut);
}

export function weekday(s) {
  return new Date(toUtc(s)).getUTCDay();
}

/** "sab 17 lug" */
export function fmtShort(s) {
  if (!isIsoDate(s)) return '';
  const [, m, d] = s.split('-').map(Number);
  return `${DAYS_SHORT[weekday(s)]} ${d} ${MONTHS_SHORT[m - 1]}`;
}

/** "sabato 17 luglio" (con l'anno se diverso da quello di riferimento) */
export function fmtLong(s, refYear) {
  if (!isIsoDate(s)) return '';
  const [y, m, d] = s.split('-').map(Number);
  const base = `${DAYS[weekday(s)]} ${d} ${MONTHS[m - 1]}`;
  return refYear && refYear !== y ? `${base} ${y}` : base;
}

/** "17 → 24 luglio" oppure "28 luglio → 4 agosto" */
export function fmtRange(a, b) {
  if (!isIsoDate(a) || !isIsoDate(b)) return '';
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  if (ya === yb && ma === mb) return `${da} → ${db} ${MONTHS[mb - 1]}`;
  if (ya === yb) return `${da} ${MONTHS[ma - 1]} → ${db} ${MONTHS[mb - 1]}`;
  return `${da} ${MONTHS[ma - 1]} ${ya} → ${db} ${MONTHS[mb - 1]} ${yb}`;
}

export function monthName(m) { return MONTHS[m - 1]; }

/** "oggi", "domani", "tra 3 giorni", "ieri", "3 giorni fa" */
export function relDays(s, today) {
  const n = daysBetween(today, s);
  if (n === 0) return 'oggi';
  if (n === 1) return 'domani';
  if (n === -1) return 'ieri';
  if (n > 1) return `tra ${n} giorni`;
  return `${-n} giorni fa`;
}

/** Due intervalli [a1,b1) e [a2,b2) si sovrappongono? (stesso giorno di uscita/entrata = no) */
export function overlaps(a1, b1, a2, b2) {
  return a1 < b2 && b1 > a2;
}

export function isTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/* ---------- Date e orari scritti a mano ---------- */

/** "08/11/2026" (o "8/11/26") → "2026-11-08"; null se non è una data valida. */
export function parseItDate(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const iso = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** "2026-11-08" → "08/11/2026" */
export function formatItDate(iso) {
  if (!isIsoDate(iso)) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Mentre si scrive una data: tiene solo le cifre e mette le barre da sola.
 * "0811" → "08/11/", "08112026" → "08/11/2026". Se si cancella, non rimette la barra.
 */
export function maskDate(raw, deleting = false) {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 8);
  let out = digits.slice(0, 2);
  if (digits.length > 2 || (digits.length === 2 && !deleting)) out += '/';
  out += digits.slice(2, 4);
  if (digits.length > 4 || (digits.length === 4 && !deleting)) out += '/';
  out += digits.slice(4, 8);
  return out;
}

/** Mentre si scrive un orario: "1630" → "16:30", "9" → "9", "930" → "9:30" non ambiguo solo con 4 cifre. */
export function maskTime(raw, deleting = false) {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits.length === 2 && !deleting ? `${digits}:` : digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

/** "16:30", "1630", "9:05" → "16:30" / "09:05"; null se non valido. Vuoto → "". */
export function parseTime(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const out = `${m[1].padStart(2, '0')}:${m[2]}`;
  return isTime(out) ? out : null;
}
