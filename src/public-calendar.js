// Calendario pubblico di DigiHome per Airbnb e Booking (Worker separato, senza Cloudflare Access).
//
// Airbnb e Booking leggono questo calendario dai loro server, senza poter fare il login:
// per questo vive in un Worker a parte, che fa UNA sola cosa:
//   GET /cal/<codice segreto di 48 caratteri>.ics → date occupate di una casa, nient'altro.
// Nessun nome, nessun dato degli ospiti, nessun'altra pagina. Codice sbagliato → 404.

import { addDays, todayRome } from '../public/shared/dates.js';

const HEADERS = {
  'Content-Type': 'text/calendar; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

function plain(body, status) {
  return new Response(body, { status, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

const ymd = (iso) => iso.replaceAll('-', '');

/** Testo del calendario: un evento "Non disponibile" per ogni prenotazione degli altri canali. */
export function buildIcs(bookings, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DigiHome//Calendario//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  // Alcune piattaforme rifiutano un calendario senza eventi ("link non valido"): se non c'è nessuna data
  // occupata si mette un evento di un giorno nel passato (1 gennaio 2000), che non blocca niente.
  const list = bookings.length ? bookings : [{ id: 'nessuna-data-occupata', check_in: '2000-01-01', check_out: '2000-01-02' }];
  for (const b of list) {
    lines.push('BEGIN:VEVENT', `UID:${b.id}@digihome`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(b.check_in)}`, `DTEND;VALUE=DATE:${ymd(b.check_out)}`,
      'SUMMARY:Non disponibile', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Prenotazioni da pubblicare per quel codice (null se il codice non esiste).
 * Una prenotazione di Airbnb/Booking cancellata solo nel gestionale (ext_cancel_warn = 1) è ancora attiva
 * sulla piattaforma: le sue date restano bloccate sull'altra finché la cancellazione non è confermata.
 */
export async function exportFor(db, token, today = todayRome()) {
  const cal = await db.prepare('SELECT house_id, channel FROM calendars WHERE export_token = ?').bind(token).first();
  if (!cal) return null;
  const r = await db.prepare(`SELECT id, check_in, check_out FROM bookings
    WHERE house_id = ? AND (stage <> 'cancellata' OR ext_cancel_warn = 1) AND channel <> ? AND check_out >= ?
    ORDER BY check_in`).bind(cal.house_id, cal.channel, addDays(today, -1)).all();
  return r.results || [];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return plain('Metodo non consentito.', 405);
    if (url.pathname === '/robots.txt') return plain('User-agent: *\nDisallow: /\n', 200);
    const m = /^\/cal\/([a-f0-9]{48})\.ics$/.exec(url.pathname);
    if (!m) return plain('Non trovato.', 404);
    try {
      const list = await exportFor(env.DB, m[1]);
      if (!list) return plain('Non trovato.', 404);
      return new Response(request.method === 'HEAD' ? null : buildIcs(list), { status: 200, headers: HEADERS });
    } catch (e) {
      console.error('Calendario pubblico', e && e.stack ? e.stack : e);
      return plain('Errore temporaneo.', 503);
    }
  },
};
