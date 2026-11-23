// Importazione di prenotazioni da un foglio (vecchio Excel o CSV): riconoscimento delle colonne,
// conversione di date, importi, canali e case. Il file si legge sul dispositivo; al server vanno solo
// i campi scelti, riga per riga, controllati di nuovo come una prenotazione nuova.

import { addDays, isIsoDate } from './dates.js';
import { parseEuro } from './money.js';

export const IMPORT_FIELDS = {
  check_in: { label: 'Arrivo', required: true, words: ['arrivo', 'check in', 'checkin', 'check-in', 'dal', 'inizio', 'data arrivo', 'data di arrivo', 'start'] },
  check_out: { label: 'Partenza', required: false, words: ['partenza', 'check out', 'checkout', 'check-out', 'al', 'fine', 'data partenza', 'data di partenza', 'end'] },
  nights: { label: 'Notti, se manca la partenza', required: false, words: ['notti', 'nights', 'n notti', 'numero notti'] },
  house: { label: 'Casa', required: false, words: ['casa', 'struttura', 'appartamento', 'alloggio', 'immobile', 'property'] },
  channel: { label: 'Canale', required: false, words: ['canale', 'portale', 'piattaforma', 'fonte', 'provenienza', 'channel', 'source'] },
  guests: { label: 'Persone', required: false, words: ['persone', 'ospiti', 'pax', 'n ospiti', 'numero ospiti', 'guests', 'adulti'] },
  total: { label: 'Prezzo del soggiorno', required: true, words: ['prezzo', 'totale', 'lordo', 'importo', 'incasso', 'tariffa', 'price', 'total', 'compenso'] },
  guest_name: { label: 'Nome dell’ospite', required: false, words: ['nome', 'ospite', 'cliente', 'cognome', 'nominativo', 'name', 'guest'] },
  phone: { label: 'Telefono', required: false, words: ['telefono', 'cellulare', 'tel', 'phone', 'numero di telefono'] },
  // Quando è arrivata la prenotazione: serve al ritmo delle prenotazioni nel listino (facoltativa).
  booked_on: { label: 'Data della prenotazione', required: false, words: ['data prenotazione', 'data di prenotazione', 'prenotata il', 'prenotato il', 'data della prenotazione', 'booked', 'booking date', 'data creazione', 'creata il'] },
};

const norm = (s) => [...String(s ?? '').toLowerCase().normalize('NFD')].filter((ch) => { const c = ch.codePointAt(0); return c < 0x300 || c > 0x36F; }).join('').replace(/[^a-z0-9]+/g, ' ').trim();

/** Riga delle intestazioni: la prima con almeno due celle scritte (entro le prime 20). */
export function headerRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    if ((rows[i] || []).filter((c) => c !== null && String(c).trim() !== '').length >= 2) return i;
  }
  return 0;
}

/** Abbinamento automatico colonne → campi, dai nomi delle intestazioni. { campo: indice | null } */
export function guessMapping(headers) {
  const used = new Set();
  const out = {};
  const names = headers.map(norm);
  for (const [key, f] of Object.entries(IMPORT_FIELDS)) {
    out[key] = null;
    // Prima le corrispondenze esatte, poi quelle che iniziano con la parola.
    for (const exact of [true, false]) {
      if (out[key] !== null) break;
      for (let i = 0; i < names.length; i++) {
        if (used.has(i) || !names[i]) continue;
        const hit = f.words.some((w) => (exact ? names[i] === w : names[i].startsWith(`${w} `) || names[i].endsWith(` ${w}`)));
        if (hit) { out[key] = i; used.add(i); break; }
      }
    }
  }
  return out;
}

/** Data da cella: numero di Excel (giorni dal 30/12/1899), "25/08/2025", "25-08-25", "2025-08-25", oggetto Date. */
export function toIsoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(s);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return valid(y, +m[2], +m[1]);
  }
  return null;
}

function valid(y, mo, d) {
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(iso) && y >= 2000 && y <= 2100 ? iso : null;
}

/** Importo in centesimi: numero (euro) o testo "1.650,00 €". */
export function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
  const s = String(v).replace(/eur(o)?/i, '').trim();
  const c = parseEuro(s);
  if (c !== null) return c;
  const n = Number(s.replace(/\s|€/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export function toChannel(v) {
  const s = norm(v);
  if (!s) return null;
  if (s.includes('airbnb')) return 'airbnb';
  if (s.includes('booking')) return 'booking';
  return 'diretto';
}

export function toHouse(v, houses) {
  const s = norm(v);
  if (!s) return null;
  for (const h of houses) {
    const n = norm(h.name);
    if (s === n || s.includes(n) || n.includes(s) || s.includes(norm(h.name).split(' ')[0])) return h.id;
  }
  return null;
}

/**
 * Righe del foglio → prenotazioni da importare.
 * opt: { mapping, header (indice della riga delle intestazioni), houses, fixedHouse, fixedChannel, withNames }
 * Restituisce [{ line (numero di riga nel foglio), ok, row?, error? }] saltando le righe vuote.
 */
export function buildImport(rows, { mapping, header, houses, fixedHouse = null, fixedChannel = null, withNames = true }) {
  const out = [];
  const get = (r, key) => (mapping[key] === null || mapping[key] === undefined ? null : r[mapping[key]] ?? null);
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => c !== null && String(c).trim() !== '')) continue;
    const line = i + 1;
    const fail = (error) => out.push({ line, ok: false, error });
    const ci = toIsoDate(get(r, 'check_in'));
    if (!ci) { fail('data di arrivo mancante o non valida'); continue; }
    let co = toIsoDate(get(r, 'check_out'));
    if (!co && mapping.nights !== null && mapping.nights !== undefined) {
      const n = Number(String(get(r, 'nights') ?? '').replace(',', '.'));
      if (Number.isInteger(n) && n > 0 && n <= 90) co = addDays(ci, n);
    }
    if (!co) { fail('data di partenza mancante o non valida'); continue; }
    if (co <= ci) { fail('la partenza non è dopo l’arrivo'); continue; }
    const house = fixedHouse || toHouse(get(r, 'house'), houses);
    if (!house) { fail('casa non riconosciuta'); continue; }
    const channel = fixedChannel || toChannel(get(r, 'channel')) || 'diretto';
    const total = toCents(get(r, 'total'));
    if (total === null) { fail('prezzo mancante o non valido'); continue; }
    const g = Number(String(get(r, 'guests') ?? '').trim() || 2);
    const guests = Number.isInteger(g) && g >= 1 && g <= 50 ? g : null;
    if (!guests) { fail('numero di persone non valido'); continue; }
    const name = withNames ? String(get(r, 'guest_name') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const phoneRaw = withNames ? String(get(r, 'phone') ?? '').trim() : '';
    const phone = /^[+()\d\s./-]{5,40}$/.test(phoneRaw) ? phoneRaw : null;
    const bookedOn = toIsoDate(get(r, 'booked_on'));
    out.push({ line, ok: true, row: { house_id: house, channel, guest_name: name || 'Ospite (importato)', phone, guests, check_in: ci, check_out: co, total_cents: total,
      booked_on: bookedOn && bookedOn <= ci ? bookedOn : null } });
  }
  return out;
}

/** Doppioni: righe che si sovrappongono a prenotazioni già presenti (o a righe precedenti dello stesso file). */
export function markDuplicates(items, bookings) {
  const taken = bookings.filter((b) => b.stage !== 'cancellata').map((b) => ({ h: b.house_id, a: b.check_in, z: b.check_out }));
  for (const it of items) {
    if (!it.ok) continue;
    const r = it.row;
    if (taken.some((t) => t.h === r.house_id && t.a < r.check_out && t.z > r.check_in)) { it.duplicate = true; continue; }
    taken.push({ h: r.house_id, a: r.check_in, z: r.check_out });
  }
  return items;
}
