// Preventivi: prezzo consigliato dallo storico, controlli sulle date e messaggio WhatsApp.
// Il preventivo NON si salva (scelta di Mattia): si calcola, si prepara il messaggio e si invia.
// Usato dall'app; le impostazioni (per casa) le controlla anche il server.

import { addDays, daysBetween, isIsoDate, overlaps } from './dates.js';
import { fmtEuro } from './money.js';
import { euroEn } from './contract-en.js';
import { touristTax } from './tax.js';

/** Impostazioni di partenza: acconto 30% (dai dati del contratto), validità 7 giorni, minimo 5 notti a luglio e agosto. */
export const DEFAULT_QUOTE = {
  validity_days: 7,
  security_cents: 25000,
  min_nights: [0, 0, 0, 0, 0, 0, 5, 5, 0, 0, 0, 0],
  window_days: 20,
  long_stay: [{ nights: 7, pct: 5 }, { nights: 14, pct: 10 }],
  early: { days: 120, pct: 5 },
  last_minute: { days: 14, pct: 10 },
  extras: [{ id: 'garage', label: 'Garage', label_en: 'Garage', price_cents: 1000, unit: 'persona' }],
  note: '',
  note_en: '',
};

export const EXTRA_UNITS = {
  persona: { it: 'a persona per tutto il soggiorno', en: 'per person for the whole stay', short: 'a persona' },
  notte: { it: 'a notte', en: 'per night', short: 'a notte' },
  soggiorno: { it: 'per tutto il soggiorno', en: 'for the whole stay', short: 'a soggiorno' },
};

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Impostazioni dei preventivi di una casa, sempre valide (se mancano o sono rovinate: quelle di partenza). */
export function quoteSettings(house) {
  let raw = house && house.quote_settings;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw) return clone(DEFAULT_QUOTE);
  const r = checkQuoteSettings(raw);
  return r.ok ? r.value : clone(DEFAULT_QUOTE);
}

/** Controllo delle impostazioni. Restituisce { ok, value } oppure { ok: false, error, field }. */
export function checkQuoteSettings(input) {
  const bad = (error, field) => ({ ok: false, error, field });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Impostazioni non valide');
  const int = (v, min, max) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const v = {};
  v.validity_days = int(input.validity_days ?? DEFAULT_QUOTE.validity_days, 1, 60);
  if (v.validity_days === null) return bad('Validità: da 1 a 60 giorni', 'validity_days');
  v.security_cents = int(input.security_cents ?? 0, 0, 1000000);
  if (v.security_cents === null) return bad('Cauzione non valida', 'security_cents');
  v.window_days = int(input.window_days ?? DEFAULT_QUOTE.window_days, 0, 60);
  if (v.window_days === null) return bad('Periodo simile: da 0 a 60 giorni', 'window_days');
  const mn = input.min_nights ?? DEFAULT_QUOTE.min_nights;
  if (!Array.isArray(mn) || mn.length !== 12) return bad('Servono le notti minime dei 12 mesi', 'min_nights');
  v.min_nights = mn.map((x) => int(x === '' || x === null ? 0 : x, 0, 60));
  if (v.min_nights.some((x) => x === null)) return bad('Notti minime: da 0 a 60', 'min_nights');
  const ls = input.long_stay ?? [];
  if (!Array.isArray(ls) || ls.length > 4) return bad('Sconti per soggiorni lunghi non validi', 'long_stay');
  v.long_stay = [];
  for (const x of ls) {
    const nights = int(x && x.nights, 2, 90);
    const pct = int(x && x.pct, 0, 50);
    if (nights === null || pct === null) return bad('Sconti per soggiorni lunghi: notti da 2 a 90, sconto da 0 a 50%', 'long_stay');
    if (pct > 0) v.long_stay.push({ nights, pct });
  }
  v.long_stay.sort((a, b) => a.nights - b.nights);
  for (const k of ['early', 'last_minute']) {
    const x = input[k] ?? { days: 0, pct: 0 };
    const days = int(x.days, 0, 365);
    const pct = int(x.pct, 0, 50);
    if (days === null || pct === null) return bad(k === 'early' ? 'Prenotazione anticipata non valida' : 'Ultimo minuto non valido', k);
    v[k] = { days, pct };
  }
  const ex = input.extras ?? [];
  if (!Array.isArray(ex) || ex.length > 10) return bad('Extra non validi (massimo 10)', 'extras');
  v.extras = [];
  const ids = new Set();
  for (const x of ex) {
    const label = String((x && x.label) ?? '').replace(/\s+/g, ' ').trim();
    const labelEn = String((x && x.label_en) ?? '').replace(/\s+/g, ' ').trim();
    const price = int(x && x.price_cents, 0, 1000000);
    if (!label || label.length > 40 || labelEn.length > 40) return bad('Nome dell’extra mancante o troppo lungo', 'extras');
    if (price === null) return bad(`Prezzo non valido per ${label}`, 'extras');
    if (!EXTRA_UNITS[x.unit]) return bad(`Scegli come si conta ${label}`, 'extras');
    let id = String(x.id || label).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'extra';
    while (ids.has(id)) id += '-2';
    ids.add(id);
    v.extras.push({ id, label, label_en: labelEn || null, price_cents: price, unit: x.unit });
  }
  for (const k of ['note', 'note_en']) {
    const s = String(input[k] ?? '').replace(/\r\n?/g, '\n').trim();
    if (s.length > 500) return bad('Nota troppo lunga (massimo 500 caratteri)', k);
    v[k] = s;
  }
  return { ok: true, value: v };
}

/* ------------------------------ Storico ------------------------------ */

/** Stessa data k anni prima ('2027-02-29' non esiste: diventa il 28). */
function yearsBack(iso, k) {
  const y = Number(iso.slice(0, 4)) - k;
  const md = iso.slice(5) === '02-29' ? '02-28' : iso.slice(5);
  return `${y}-${md}`;
}

/**
 * Prezzo a notte dei soggiorni degli anni precedenti in un periodo simile (le stesse date ± window giorni).
 * Media pesata sulle notti che cadono nel periodo. Solo soggiorni conclusi, non cancellati, con il prezzo.
 * Restituisce { perNight, count, stays: [...] } (perNight = null se non c'è niente).
 */
export function historyPrice(bookings, houseId, checkIn, checkOut, { windowDays = 20, today, years = 6 } = {}) {
  const stays = [];
  let sum = 0;
  let weight = 0;
  for (let k = 1; k <= years; k++) {
    const ws = yearsBack(addDays(checkIn, -windowDays), k);
    const we = yearsBack(addDays(checkOut, windowDays), k);
    for (const b of bookings) {
      if (b.house_id !== houseId || b.stage === 'cancellata' || !(b.total_cents > 0)) continue;
      if (today && b.check_out > today) continue;
      if (!overlaps(b.check_in, b.check_out, ws, we)) continue;
      const n = daysBetween(b.check_in, b.check_out);
      if (n < 1) continue;
      const from = b.check_in > ws ? b.check_in : ws;
      const to = b.check_out < we ? b.check_out : we;
      const inWindow = daysBetween(from, to);
      const perNight = Math.round(b.total_cents / n);
      stays.push({ id: b.id, check_in: b.check_in, check_out: b.check_out, nights: n, guests: b.guests, channel: b.channel, perNight, inWindow });
      sum += perNight * inWindow;
      weight += inWindow;
    }
  }
  stays.sort((a, b) => (a.check_in < b.check_in ? 1 : -1));
  return { perNight: weight ? Math.round(sum / weight) : null, count: stays.length, stays };
}

/* ------------------------------ Prezzo consigliato ------------------------------ */

const round10 = (cents) => Math.round(cents / 1000) * 1000;

/**
 * Prezzo consigliato: media dello storico × notti, poi le correzioni (soggiorno lungo, anticipo, ultimo minuto).
 * Restituisce { base, adjustments: [{ label, pct }], total, perNight } oppure null se manca lo storico.
 */
export function suggestPrice(history, { checkIn, checkOut, today, settings }) {
  if (!history || !history.perNight) return null;
  const n = daysBetween(checkIn, checkOut);
  const base = history.perNight * n;
  const adjustments = [];
  const long = [...settings.long_stay].reverse().find((x) => n >= x.nights);
  if (long) adjustments.push({ label: `Soggiorno di ${n} notti (da ${long.nights})`, pct: -long.pct });
  const ahead = daysBetween(today, checkIn);
  if (settings.early.pct && settings.early.days && ahead >= settings.early.days) {
    adjustments.push({ label: `Richiesta con molto anticipo (${ahead} giorni)`, pct: settings.early.pct });
  } else if (settings.last_minute.pct && ahead >= 0 && ahead <= settings.last_minute.days) {
    adjustments.push({ label: `Ultimo minuto (arrivo tra ${ahead} ${ahead === 1 ? 'giorno' : 'giorni'})`, pct: -settings.last_minute.pct });
  }
  const pct = adjustments.reduce((s, x) => s + x.pct, 0);
  const total = Math.max(1000, round10(base * (1 + pct / 100)));
  return { base, adjustments, total, perNight: Math.round(total / n) };
}

/** Acconto: percentuale del prezzo, arrotondata a 50 € (mai più del prezzo). */
export function depositFor(totalCents, pct) {
  if (!(totalCents > 0) || !(pct > 0)) return 0;
  const raw = (totalCents * pct) / 100;
  const r = Math.round(raw / 5000) * 5000;
  return Math.min(totalCents, r || Math.round(raw / 1000) * 1000);
}

/** Totale di un extra per questo soggiorno. */
export function extraAmount(x, { guests, nights }) {
  if (x.unit === 'persona') return x.price_cents * guests;
  if (x.unit === 'notte') return x.price_cents * nights;
  return x.price_cents;
}

/* ------------------------------ Controlli sulle date ------------------------------ */

/**
 * Avvisi sulle date: occupate, sotto le notti minime, notti scoperte prima o dopo, troppe persone.
 * Restituisce [{ level: 'bad' | 'warn' | 'ok', text }].
 */
export function quoteChecks(bookings, house, settings, { checkIn, checkOut, guests, today }) {
  const out = [];
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn) return out;
  const n = daysBetween(checkIn, checkOut);
  if (checkIn < today) out.push({ level: 'bad', text: 'La data di arrivo è già passata.' });
  const mine = bookings.filter((b) => b.house_id === house.id && b.stage !== 'cancellata');
  const clash = mine.filter((b) => overlaps(b.check_in, b.check_out, checkIn, checkOut));
  for (const b of clash) out.push({ level: 'bad', text: `Date occupate: c’è già ${b.guest_name} dal ${b.check_in.split('-').reverse().join('/')} al ${b.check_out.split('-').reverse().join('/')}.` });
  if (!clash.length && checkIn >= today) out.push({ level: 'ok', text: 'Le date sono libere.' });
  if (guests > house.max_guests) out.push({ level: 'bad', text: `In questa casa al massimo ${house.max_guests} persone.` });
  let minN = 0;
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) minN = Math.max(minN, settings.min_nights[Number(d.slice(5, 7)) - 1] || 0);
  if (minN && n < minN) out.push({ level: 'warn', text: `In questo periodo di solito il minimo è ${minN} notti (qui ${n}).` });
  if (!clash.length) {
    const prev = mine.filter((b) => b.check_out <= checkIn).sort((a, b) => (a.check_out < b.check_out ? 1 : -1))[0];
    const next = mine.filter((b) => b.check_in >= checkOut).sort((a, b) => (a.check_in > b.check_in ? 1 : -1))[0];
    const gapLimit = Math.max(2, minN - 1);
    if (prev) {
      const g = daysBetween(prev.check_out, checkIn);
      if (g >= 1 && g <= gapLimit && prev.check_out >= today) out.push({ level: 'warn', text: `Prima restano ${g} ${g === 1 ? 'notte libera' : 'notti libere'} difficili da vendere: puoi proporre di anticipare l’arrivo.` });
    }
    if (next) {
      const g = daysBetween(checkOut, next.check_in);
      if (g >= 1 && g <= gapLimit) out.push({ level: 'warn', text: `Dopo restano ${g} ${g === 1 ? 'notte libera' : 'notti libere'} difficili da vendere: puoi proporre di allungare il soggiorno.` });
    }
  }
  return out;
}

/* ------------------------------ Messaggio ------------------------------ */

const MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "25–31 agosto 2026", "28 luglio – 4 agosto 2026", "28 dicembre 2026 – 3 gennaio 2027" (e in inglese). */
export function rangeText(a, b, lang = 'it') {
  const M = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  if (lang === 'en') {
    if (ya === yb && ma === mb) return `${M[ma - 1]} ${da}–${db}, ${ya}`;
    if (ya === yb) return `${M[ma - 1]} ${da} – ${M[mb - 1]} ${db}, ${ya}`;
    return `${M[ma - 1]} ${da}, ${ya} – ${M[mb - 1]} ${db}, ${yb}`;
  }
  if (ya === yb && ma === mb) return `${da}–${db} ${M[ma - 1]} ${ya}`;
  if (ya === yb) return `${da} ${M[ma - 1]} – ${db} ${M[mb - 1]} ${ya}`;
  return `${da} ${M[ma - 1]} ${ya} – ${db} ${M[mb - 1]} ${yb}`;
}

function dayText(iso, lang) {
  const [, m, d] = iso.split('-').map(Number);
  return lang === 'en' ? `${MONTHS_EN[m - 1]} ${d}` : `${d} ${MONTHS_IT[m - 1]}`;
}

/**
 * Testo del preventivo per WhatsApp (in italiano o in inglese).
 * q: { lang, name, checkIn, checkOut, guests, price, deposit, security, linens, towels, extras: [{ label, label_en, amount, price_cents, unit }], validUntil }
 * info: dati del contratto della casa (kWh compresi e prezzo); taxSettings: tariffe della tassa.
 */
export function quoteMessage(q, house, info, taxSet) {
  const en = q.lang === 'en';
  const eur = en ? euroEn : fmtEuro;
  const n = daysBetween(q.checkIn, q.checkOut);
  const tax = touristTax(q.checkIn, q.checkOut, q.guests, taxSet);
  const L = [];
  const name = String(q.name || '').trim().split(/\s+/)[0];
  if (en) L.push(name ? `Hi ${name}, here is the quote for ${house.name}:` : `Here is the quote for ${house.name}:`);
  else L.push(name ? `Ciao ${name}, ecco il preventivo per ${house.name}:` : `Ecco il preventivo per ${house.name}:`);
  L.push('');
  L.push(en ? `Dates: ${rangeText(q.checkIn, q.checkOut, 'en')} (${n} ${n === 1 ? 'night' : 'nights'})` : `Date: ${rangeText(q.checkIn, q.checkOut)} (${n} ${n === 1 ? 'notte' : 'notti'})`);
  L.push(en ? `Guests: ${q.guests}` : `Ospiti: ${q.guests}`);
  L.push(`*${en ? 'Price' : 'Prezzo'}: ${eur(q.price)}*`);
  L.push('');
  L.push(en ? 'The price includes:' : 'Il prezzo include:');
  if (q.linens && q.towels) L.push(en ? '- bed linen for every bed and towels' : '- lenzuola per ogni letto e asciugamani');
  else if (q.linens) L.push(en ? '- bed linen for every bed (towels not included)' : '- lenzuola per ogni letto (asciugamani non inclusi)');
  else if (q.towels) L.push(en ? '- towels (bed linen not included)' : '- asciugamani (lenzuola non incluse)');
  L.push(en ? '- water' : '- consumi di acqua');
  if (info.kwh_day) {
    L.push(en
      ? `- electricity up to ${info.kwh_day} kWh per day; any extra consumption is charged separately at ${euroEn(info.kwh_price_cents)}/kWh, read from the electricity meter`
      : `- consumi di luce fino a ${info.kwh_day} kWh al giorno; eventuali eccedenze a parte, al costo di ${fmtEuro(info.kwh_price_cents)}/kWh, misurate con il contatore della luce`);
  } else L.push(en ? '- electricity' : '- consumi di luce');
  L.push(en ? '- final cleaning' : '- pulizie finali');
  if (!q.linens && !q.towels) L.push(en ? '(bed linen and towels not included)' : '(lenzuola e asciugamani non inclusi)');
  L.push('');
  const apart = [];
  if (tax.amount > 0) {
    const single = tax.parts.length === 1 && tax.counted === tax.nights;
    const how = single ? (en ? ` (${euroEn(tax.parts[0].rate)} per person per night)` : ` (${fmtEuro(tax.parts[0].rate)} a persona a notte)`) : '';
    apart.push(en ? `- tourist tax: ${euroEn(tax.amount)}${how}, paid on arrival` : `- tassa di soggiorno: ${fmtEuro(tax.amount)}${how}, da pagare all’arrivo`);
  }
  for (const x of q.extras) {
    const unit = EXTRA_UNITS[x.unit];
    const label = en ? (x.label_en || x.label) : x.label;
    const how = x.unit === 'soggiorno' ? '' : ` (${eur(x.price_cents)} ${en ? unit.en : unit.it})`;
    apart.push(`- ${label.toLowerCase()}: ${eur(x.amount)}${how}`);
  }
  if (q.security > 0) {
    apart.push(en ? `- security deposit: ${euroEn(q.security)}, returned at the end of the stay if there is no damage to the house`
      : `- cauzione: ${fmtEuro(q.security)}, restituita alla fine del soggiorno se non ci sono danni alla casa`);
  }
  if (apart.length) L.push(en ? 'Not included:' : 'A parte:', ...apart, '');
  const rest = Math.max(0, q.price - q.deposit);
  const plus = [];
  if (q.security > 0) plus.push(en ? `${euroEn(q.security)} security deposit` : `${fmtEuro(q.security)} di cauzione`);
  if (tax.amount > 0) plus.push(en ? `${euroEn(tax.amount)} tourist tax` : `${fmtEuro(tax.amount)} di tassa di soggiorno`);
  for (const x of q.extras) plus.push(en ? `${euroEn(x.amount)} ${(x.label_en || x.label).toLowerCase()}` : `${fmtEuro(x.amount)} di ${x.label.toLowerCase()}`);
  if (q.deposit > 0) {
    L.push(en ? `*Deposit by bank transfer: ${euroEn(q.deposit)}* (non-refundable)` : `*Bonifico acconto: ${fmtEuro(q.deposit)}* (non rimborsabile)`);
    L.push(en ? `Balance on arrival: ${[euroEn(rest), ...plus].join(' + ')}` : `Saldo all’arrivo: ${[fmtEuro(rest), ...plus].join(' + ')}`);
  } else {
    L.push(en ? `Payment on arrival: ${[euroEn(q.price), ...plus].join(' + ')}` : `Pagamento all’arrivo: ${[fmtEuro(q.price), ...plus].join(' + ')}`);
  }
  L.push('');
  L.push(en ? `Check-in from ${house.checkin_time}, check-out by ${house.checkout_time}.` : `Check-in dalle ${house.checkin_time}, check-out entro le ${house.checkout_time}.`);
  if (q.validUntil) L.push(en ? `This quote is valid until ${dayText(q.validUntil, 'en')}.` : `Il preventivo è valido fino al ${dayText(q.validUntil, 'it')}.`);
  const note = en ? (q.note_en || q.note) : q.note;
  if (note) { L.push(''); L.push(note); }
  return L.join('\n');
}
