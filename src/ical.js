// Lettura dei calendari iCal (.ics) di Airbnb e Booking.
// Si leggono solo gli eventi (VEVENT) con: codice (UID), date di inizio e fine, titolo, descrizione.

const MAX_EVENTS = 3000;

function unescapeText(s) {
  return s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** 'AAAAMMGG' o 'AAAAMMGGThhmmss[Z]' → 'AAAA-MM-GG' (solo la data). */
function toDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/.exec(value.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/**
 * Restituisce { ok: true, events: [{ uid, start, end, summary, description }] }
 * oppure { ok: false, error } se il testo non è un calendario.
 * end è il giorno di partenza (escluso), come nelle prenotazioni.
 */
export function parseIcs(text) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) {
    return { ok: false, error: 'Il link non restituisce un calendario.' };
  }
  // Righe spezzate: una riga che inizia con spazio o tab continua la precedente.
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (upper === 'END:VEVENT') {
      if (cur && cur.uid && cur.start && cur.end && cur.end > cur.start) {
        events.push({ uid: cur.uid, start: cur.start, end: cur.end, summary: cur.summary || '', description: cur.description || '', status: cur.status || '' });
        if (events.length > MAX_EVENTS) return { ok: false, error: 'Calendario troppo grande.' };
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(';')[0].toUpperCase();
    const value = line.slice(colon + 1);
    if (name === 'UID') cur.uid = value.trim().slice(0, 300);
    else if (name === 'DTSTART') cur.start = toDate(value);
    else if (name === 'DTEND') cur.end = toDate(value);
    else if (name === 'SUMMARY') cur.summary = unescapeText(value).slice(0, 300);
    else if (name === 'DESCRIPTION') cur.description = unescapeText(value).slice(0, 2000);
    else if (name === 'STATUS') cur.status = value.trim().toUpperCase();
  }
  return { ok: true, events };
}

/** È un blocco di date (non una prenotazione)? Airbnb: "Airbnb (Not available)". */
export function isBlock(ev) {
  return /not available|non disponibile|blocked|bloccat/i.test(ev.summary) || ev.status === 'CANCELLED';
}

/** Dati utili dalla descrizione di Airbnb: link e codice della prenotazione. */
export function airbnbInfo(ev) {
  const m = /https:\/\/(?:www\.)?airbnb\.[a-z.]{2,8}\/hosting\/reservations\/details\/([A-Z0-9]{6,14})\b/.exec(ev.description);
  if (!m) return { code: null, url: null };
  return { code: m[1], url: m[0] };
}
