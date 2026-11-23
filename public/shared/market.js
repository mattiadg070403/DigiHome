// Mercato (versione 0.17): case simili su Airbnb lette con Apify, per confrontare prezzi, disponibilità,
// dotazioni e spese a parte, e dare consigli sui prezzi del listino e del preventivo.
// Scelte di Mattia (23/11/2026): tutte e due le case, separate; 10 case simili per casa; sintesi + consigli.
// Solo dati pubblici degli annunci (niente nomi degli host, niente recensioni). Usato dall'app e dal server.

import { isIsoDate } from './dates.js';

export const MAX_SELECTED = 10;
export const MAX_CANDIDATES = 15;

/** Dotazioni confrontate (chiave → etichetta e parole degli annunci in inglese, la lingua chiesta ad Apify). */
export const AMENITIES = {
  aria_condizionata: { label: 'Aria condizionata', re: /air ?condition|^ac\b|central air|portable air/i },
  wifi: { label: 'Wi-Fi', re: /wi-?fi|wireless internet/i },
  parcheggio: { label: 'Parcheggio', re: /parking|garage/i },
  terrazza: { label: 'Terrazza o balcone', re: /patio|balcony|terrace|rooftop/i },
  vista_mare: { label: 'Vista mare', re: /(sea|ocean|beach|bay|harbor|harbour) view/i },
  spiaggia: { label: 'Accesso alla spiaggia', re: /beach access|beachfront|waterfront/i },
  lavatrice: { label: 'Lavatrice', re: /^washer\b|washing machine|^washer –|^free washer|^paid washer/i },
  lavastoviglie: { label: 'Lavastoviglie', re: /dishwasher/i },
  piscina: { label: 'Piscina', re: /\bpool\b(?! table)/i },
  animali: { label: 'Animali ammessi', re: /pets allowed/i },
  barbecue: { label: 'Barbecue', re: /bbq|barbecue/i },
  doccia_esterna: { label: 'Doccia esterna', re: /outdoor shower/i },
  tv: { label: 'TV', re: /^tv\b|hdtv|television/i },
};

// guests: posti (ospiti) della casa per il confronto; vuoto = il massimo di ospiti della casa. Criterio importante (Mattia, 23/11).
export const DEFAULT_MARKET = { lat: null, lon: null, radius_km: 3, guests: null, bedrooms: null, amenities: [], query: 'Gallipoli, Puglia, Italy' };

const clone = (x) => JSON.parse(JSON.stringify(x));

export function marketSettings(house) {
  let raw = house && house.market_settings;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw) return clone(DEFAULT_MARKET);
  const r = checkMarketSettings(raw);
  return r.ok ? r.value : clone(DEFAULT_MARKET);
}

/**
 * Coordinate copiate da Google Maps ("40.0558, 17.9925") o da Mappe di Apple ("40,0558° N, 17,9925° E")
 * → { lat, lon }, oppure null.
 */
export function parseCoords(text) {
  const t = String(text || '').trim();
  const m = /^(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EWO])?$/i.exec(t);
  if (!m) return null;
  let lat = Number(m[1].replace(',', '.'));
  let lon = Number(m[3].replace(',', '.'));
  if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4] && /[WO]/i.test(m[4])) lon = -Math.abs(lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 ? { lat, lon } : null;
}

export function checkMarketSettings(input) {
  const bad = (error, field) => ({ ok: false, error, field });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Impostazioni non valide');
  const v = {};
  const has = (k) => input[k] !== null && input[k] !== undefined && input[k] !== '';
  if (has('lat') || has('lon')) {
    const lat = Number(input.lat);
    const lon = Number(input.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return bad('Posizione non valida', 'coords');
    v.lat = Math.round(lat * 1e6) / 1e6;
    v.lon = Math.round(lon * 1e6) / 1e6;
  } else { v.lat = null; v.lon = null; }
  const r = Number(input.radius_km ?? DEFAULT_MARKET.radius_km);
  if (!Number.isFinite(r) || r < 0.3 || r > 30) return bad('Raggio: da 0,3 a 30 km', 'radius_km');
  v.radius_km = Math.round(r * 10) / 10;
  if (has('guests')) {
    const g = Number(input.guests);
    if (!Number.isInteger(g) || g < 1 || g > 30) return bad('Posti: da 1 a 30', 'guests');
    v.guests = g;
  } else v.guests = null;
  if (has('bedrooms')) {
    const b = Number(input.bedrooms);
    if (!Number.isInteger(b) || b < 0 || b > 20) return bad('Camere da letto: da 0 a 20', 'bedrooms');
    v.bedrooms = b;
  } else v.bedrooms = null;
  const am = input.amenities ?? [];
  if (!Array.isArray(am) || am.some((k) => !AMENITIES[k])) return bad('Dotazioni non valide', 'amenities');
  v.amenities = [...new Set(am)];
  const q = String(input.query ?? DEFAULT_MARKET.query).replace(/\s+/g, ' ').trim();
  if (!q || q.length > 80 || /[<>{}]/.test(q)) return bad('Luogo della ricerca non valido', 'query');
  v.query = q;
  return { ok: true, value: v };
}

/* ------------------------------ Lettura dei risultati di Apify ------------------------------ */

/** "€1,234.56", "€ 1.234", "1234" → centesimi (null se non è un importo). */
export function moneyToCents(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? Math.round(s * 100) : null;
  let t = String(s).replace(/[^\d.,]/g, '');
  if (!t || !/\d/.test(t)) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) t = t.replace(/,/g, ''); // 1,234.56
  else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); // 1.234,56
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Numero di camere e posti dal sottotitolo dell'annuncio ("2 bedrooms", "Studio", "6 guests"). */
function countFrom(items, re) {
  for (const x of items || []) {
    const m = re.exec(String(x));
    if (m) return Number(m[1]);
  }
  return null;
}

const listingIdFrom = (x) => {
  const id = String(x.id ?? '').replace(/\D/g, '');
  if (id) return id.slice(0, 30);
  const m = /\/rooms\/(\d+)/.exec(String(x.url || ''));
  return m ? m[1].slice(0, 30) : null;
};

/** Dotazioni dell'annuncio → nostre chiavi (solo quelle presenti). */
export function amenityKeys(amenities) {
  const titles = [];
  for (const group of Array.isArray(amenities) ? amenities : []) {
    for (const v of Array.isArray(group && group.values) ? group.values : []) {
      if (v && v.available !== false && typeof v.title === 'string') titles.push(v.title.trim());
    }
  }
  return Object.keys(AMENITIES).filter((k) => titles.some((t) => AMENITIES[k].re.test(t)));
}

/**
 * Un risultato di Apify (ricerca o singolo annuncio) → dati che teniamo. Niente host, niente recensioni.
 * Restituisce null se manca l'annuncio.
 */
export function readListing(x) {
  if (!x || typeof x !== 'object') return null;
  const listingId = listingIdFrom(x);
  if (!listingId) return null;
  const items = (x.subDescription && x.subDescription.items) || [];
  const bedrooms = /studio/i.test(items.join(' ')) ? 0 : countFrom(items, /(\d+)\s*bedrooms?/i);
  const capacity = Number.isInteger(x.personCapacity) ? x.personCapacity : countFrom(items, /(\d+)\s*guests?/i);
  const coords = x.coordinates && Number.isFinite(x.coordinates.latitude) && Number.isFinite(x.coordinates.longitude)
    ? { lat: x.coordinates.latitude, lon: x.coordinates.longitude } : null;
  const rating = x.rating && Number.isFinite(Number(x.rating.guestSatisfaction)) ? Number(x.rating.guestSatisfaction) : null;
  const reviews = x.rating && Number.isInteger(x.rating.reviewsCount) ? x.rating.reviewsCount : null;
  return {
    listing_id: listingId,
    url: `https://www.airbnb.it/rooms/${listingId}`,
    title: typeof x.title === 'string' ? x.title.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    capacity: Number.isInteger(capacity) ? capacity : null,
    bedrooms: Number.isInteger(bedrooms) ? bedrooms : null,
    coords, rating, reviews,
    amenities: amenityKeys(x.amenities),
    ...readPrice(x.price),
  };
}

/**
 * Prezzo per le date chieste: totale per l'ospite senza tasse e senza costi del servizio (= prezzo dell'host,
 * pulizie comprese) e pulizie a parte. Se manca il prezzo, la casa non è prenotabile in quelle date.
 */
export function readPrice(price) {
  if (!price || typeof price !== 'object') return { available: false, total_cents: null, cleaning_cents: null };
  const bd = price.breakDown && typeof price.breakDown === 'object' ? price.breakDown : {};
  const val = (o) => (o && typeof o === 'object' ? moneyToCents(o.price ?? o.amount) : moneyToCents(o));
  const total = val(bd.totalBeforeTaxes);
  const service = val(bd.serviceFee) || 0;
  let cleaning = null;
  for (const [k, v] of Object.entries(bd)) {
    if (/clean/i.test(k) || (v && /clean|pulizi/i.test(String(v.description || '')))) cleaning = val(v);
  }
  for (const v of Array.isArray(bd.basePriceBreakdown) ? bd.basePriceBreakdown : []) {
    if (v && /clean|pulizi/i.test(String(v.description || ''))) cleaning = val(v);
  }
  const base = val(bd.basePrice);
  const host = total !== null ? Math.max(0, total - service) : base !== null ? base + (cleaning || 0) : moneyToCents(price.amount);
  return { available: host !== null && host > 0, total_cents: host, cleaning_cents: cleaning };
}

/* ------------------------------ Case simili ------------------------------ */

/** Distanza in metri tra due punti. */
export function distanceM(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * Quanto un annuncio somiglia alla casa (più basso = più simile): distanza, ospiti, camere, dotazioni in comune;
 * un piccolo vantaggio a chi ha molte recensioni buone (prezzi più affidabili). Fuori dal raggio o troppo diverse: null.
 */
export function similarity(l, { house, settings }) {
  const here = settings.lat !== null ? { lat: settings.lat, lon: settings.lon } : null;
  const dist = here && l.coords ? distanceM(here, l.coords) : null;
  if (dist !== null && dist > settings.radius_km * 1000) return null;
  // Posti: il criterio più importante dopo la zona (al massimo 2 di differenza, e pesa più delle camere).
  const guests = settings.guests || house.max_guests;
  const capDiff = l.capacity !== null ? Math.abs(l.capacity - guests) : 2;
  if (capDiff > 2) return null;
  const bedDiff = settings.bedrooms !== null && l.bedrooms !== null ? Math.abs(l.bedrooms - settings.bedrooms) : 1;
  if (bedDiff > 2) return null;
  const mine = new Set(settings.amenities);
  const common = l.amenities.filter((k) => mine.has(k)).length;
  const missing = settings.amenities.length - common;
  const km = dist === null ? settings.radius_km : dist / 1000;
  const trust = l.reviews ? Math.min(1, l.reviews / 50) * ((l.rating || 4) - 4) : 0;
  const score = km * 1.5 + capDiff * 2.5 + bedDiff * 1.5 + missing * 0.4 - trust;
  return { score: Math.round(score * 100) / 100, distance_m: dist };
}

/* ------------------------------ Sintesi e consigli ------------------------------ */

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Sintesi di una settimana per una casa: delle case scelte, quante sono già non disponibili e il prezzo
 * (per l'ospite, 7 notti) di quelle ancora libere. prices: righe di market_prices della casa.
 */
export function weekMarket(prices, comps, houseId, ws) {
  const chosen = new Set(comps.filter((c) => c.house_id === houseId && c.selected).map((c) => c.listing_id));
  const rows = prices.filter((p) => p.house_id === houseId && p.week_start === ws && chosen.has(p.listing_id));
  if (!rows.length) return null;
  const free = rows.filter((p) => p.status === 'libera' && p.week_cents > 0);
  const vals = free.map((p) => p.week_cents);
  const checked = rows.reduce((m, p) => (p.checked_at > m ? p.checked_at : m), '');
  return {
    checked: rows.length, free: free.length, taken: rows.length - free.length,
    takenPct: Math.round(((rows.length - free.length) / rows.length) * 100),
    median: median(vals), min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null,
    checkedAt: checked,
  };
}

const round10 = (cents) => Math.round(cents / 1000) * 1000;

/**
 * Consiglio sul prezzo di una settimana in base al mercato. myAirbnbWeek: il tuo prezzo su Airbnb per 7 notti
 * (dal listino); net: il tuo netto in tasca. Si confronta lo stesso tipo di prezzo (quello che paga l'ospite su Airbnb).
 *  - molte case già prenotate (≥ 70%) e tu sotto la mediana delle libere → alza verso la mediana;
 *  - molte libere (≥ 60%) a meno di 60 giorni e tu sopra la mediana di oltre il 10% → scendi verso la mediana;
 *  - altrimenti, se sei molto lontano (oltre il 20%) dalla mediana → segnala.
 * Restituisce null oppure { text, pct, target } (target = netto suggerito, arrotondato a 10 €).
 */
export function marketAdvice(m, { myAirbnbWeek, net, daysToArrival, minFree = 3 }) {
  if (!m || !(myAirbnbWeek > 0) || !(net > 0)) return null;
  if (m.free < minFree || !m.median) {
    if (m.checked >= 5 && m.takenPct >= 80) return { text: `${m.taken} case simili su ${m.checked} già non disponibili: settimana molto richiesta, puoi tenere o alzare il prezzo`, pct: 0, target: null };
    return null;
  }
  const diff = Math.round(((myAirbnbWeek - m.median) / m.median) * 100);
  const toward = (f) => round10(net * f);
  if (m.takenPct >= 70 && diff < -5) {
    const f = Math.min(1.15, m.median / myAirbnbWeek);
    return { text: `${m.taken} case simili su ${m.checked} già prenotate e sei il ${-diff}% sotto la media delle libere: valuta di alzare`, pct: Math.round((f - 1) * 100), target: toward(f) };
  }
  if (m.takenPct <= 40 && diff > 10 && daysToArrival !== null && daysToArrival <= 60) {
    const f = Math.max(0.85, m.median / myAirbnbWeek);
    return { text: `${m.free} case simili su ${m.checked} ancora libere e sei il ${diff}% sopra la loro media: valuta di scendere`, pct: Math.round((f - 1) * 100), target: toward(f) };
  }
  if (Math.abs(diff) >= 20) return { text: `Sei il ${Math.abs(diff)}% ${diff > 0 ? 'sopra' : 'sotto'} la media delle case simili libere`, pct: 0, target: null };
  return null;
}

/**
 * Confronto delle dotazioni: per ogni dotazione, se la tua casa ce l'ha e quante delle case scelte.
 * Più i consigli: cosa hanno quasi tutti e tu no; cosa hai tu e pochi altri (da mettere in evidenza);
 * quante chiedono le pulizie a parte.
 */
export function amenityReport(comps, houseId, settings, prices = []) {
  const chosen = comps.filter((c) => c.house_id === houseId && c.selected);
  if (!chosen.length) return null;
  const n = chosen.length;
  const mine = new Set(settings.amenities);
  const rows = Object.entries(AMENITIES).map(([k, a]) => {
    const count = chosen.filter((c) => parseList(c.amenities).includes(k)).length;
    return { key: k, label: a.label, mine: mine.has(k), count, n };
  });
  const tips = [];
  for (const r of rows) {
    if (!r.mine && r.count / n >= 0.6) tips.push({ kind: 'manca', text: `${r.count} case simili su ${n} hanno ${r.label.toLowerCase()} e la tua no (o non è segnata): se ce l'hai, aggiungila all'annuncio; se no, è un punto da considerare nel prezzo` });
    else if (r.mine && r.count / n <= 0.3) tips.push({ kind: 'forza', text: `${r.label}: ce l'hanno solo ${r.count} case simili su ${n}. È un tuo punto di forza: mettilo in evidenza nell'annuncio e nel preventivo` });
  }
  const cleanings = latestCleaning(prices, chosen);
  if (cleanings.length) {
    const med = median(cleanings);
    tips.push({ kind: 'pulizie', text: `${cleanings.length} case simili su ${n} chiedono le pulizie a parte (in media ${Math.round(med / 100)} €): sono già comprese nel loro prezzo della settimana mostrato qui` });
  }
  return { n, rows, tips };
}

function parseList(v) {
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch { return []; }
}

function latestCleaning(prices, chosen) {
  const out = [];
  for (const c of chosen) {
    const last = prices.filter((p) => p.house_id === c.house_id && p.listing_id === c.listing_id && p.cleaning_cents > 0)
      .sort((a, b) => (a.checked_at < b.checked_at ? 1 : -1))[0];
    if (last) out.push(last.cleaning_cents);
  }
  return out;
}

/** Sintesi per il preventivo: settimane toccate dal soggiorno con i dati di mercato. */
export function quoteMarket(prices, comps, houseId, weekStarts) {
  const parts = weekStarts.map((ws) => ({ ws, m: weekMarket(prices, comps, houseId, ws) })).filter((x) => x.m);
  if (!parts.length) return null;
  const meds = parts.filter((x) => x.m.median).map((x) => x.m.median / 7);
  return {
    perNight: meds.length ? Math.round(meds.reduce((s, x) => s + x, 0) / meds.length) : null,
    taken: parts.reduce((s, x) => s + x.m.taken, 0), checked: parts.reduce((s, x) => s + x.m.checked, 0),
    weeks: parts,
  };
}

export const isWeek = (s) => isIsoDate(s);
