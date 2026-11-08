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
