// Regole comuni ad app e server per i calendari di Airbnb e Booking.

export const CALENDAR_CHANNELS = ['airbnb', 'booking'];

/** Indirizzo usato come autore delle modifiche fatte dall'aggiornamento automatico. */
export const SYSTEM_EMAIL = 'calendario@digihome.invalid';

const HOSTS = {
  // www.airbnb.com, www.airbnb.it, airbnb.co.uk, ...
  airbnb: /^(?:[a-z0-9-]+\.)*airbnb\.(?:[a-z]{2,3})(?:\.[a-z]{2})?$/,
  // admin.booking.com, ical.booking.com, ...
  booking: /^(?:[a-z0-9-]+\.)*booking\.com$/,
};

/**
 * Controlla il link del calendario (iCal) di una piattaforma.
 * Restituisce { ok: true, url } oppure { ok: false, error }.
 */
export function checkCalendarUrl(channel, raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, url: null };
  if (s.length > 1000) return { ok: false, error: 'Link troppo lungo.' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'Non sembra un link: copialo per intero, deve iniziare con https://' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'Il link deve iniziare con https://' };
  if (u.username || u.password || u.port) return { ok: false, error: 'Link non valido.' };
  const host = u.hostname.toLowerCase();
  if (!HOSTS[channel] || !HOSTS[channel].test(host)) {
    const name = channel === 'airbnb' ? 'Airbnb' : 'Booking.com';
    return { ok: false, error: `Questo non è un link di ${name}. Copia il link "Esporta calendario" da ${name}.` };
  }
  return { ok: true, url: u.toString() };
}

/** Il link mostrato nell'app: si vede solo il sito, non il codice riservato. */
export function maskCalendarUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}/…`;
  } catch {
    return '…';
  }
}
