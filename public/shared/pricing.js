// Listino prezzi (versione 0.14): base per decidere i prezzi della stagione, settimana per settimana.
// Scelte di Mattia (23/11/2026):
//  - affitta da giugno a settembre, i prezzi cambiano di settimana in settimana, le prenotazioni arrivano da gennaio a maggio;
//  - per ogni settimana scrive quanto vuole avere IN TASCA (dopo commissione e cedolare): il gestionale calcola il prezzo
//    da mettere in diretta, su Airbnb e su Booking perché in tasca resti lo stesso;
//  - commissioni e cedolare sono quelle della Contabilità (una sola fonte: se cambiano lì, cambia anche il listino);
//  - niente stati delle settimane né spunte "aggiornato sul portale": solo la base per decidere;
//  - ritmo delle prenotazioni rispetto all'anno scorso e suggerimenti (mai modifiche automatiche).
// Tutti gli importi in centesimi. Usato dall'app e dal server.

import { addDays, daysBetween, isIsoDate, weekday } from './dates.js';
import { accountingSettings, channelRule, effectiveBp, stayAccount } from './accounting.js';

export const CHANNEL_ORDER = ['diretto', 'airbnb', 'booking'];
export const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
export const MONTHS_LONG = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/**
 * Impostazioni di partenza del listino (per casa):
 *  - settimane da sabato a sabato, stagione da giugno a settembre;
 *  - nessuno sconto attivo sui portali (Mattia non ne usa);
 *  - ultimo minuto: −5% a 45 giorni, −10% a 30, −15% a 14 (solo per settimane ancora libere);
 *  - oltre 90 giorni dall'arrivo niente sconti (le prenotazioni arrivano presto: si tiene il prezzo);
 *  - ritmo: 15 punti di differenza dall'anno scorso → ±5%.
 */
export const DEFAULT_PRICING = {
  week_start: 6,
  months: [6, 9],
  discounts: { airbnb: 0, booking: 0 },
  floor_cents: 0,
  hold_days: 90,
  last_minute: [{ days: 45, pct: 5 }, { days: 30, pct: 10 }, { days: 14, pct: 15 }],
  pace: { gap_pts: 15, up_pct: 5, down_pct: 5 },
};

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Impostazioni del listino di una casa, sempre valide (se mancano o sono rovinate: quelle di partenza). */
export function pricingSettings(house) {
  let raw = house && house.pricing;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw) return clone(DEFAULT_PRICING);
  const r = checkPricingSettings(raw);
  return r.ok ? r.value : clone(DEFAULT_PRICING);
}

/** Controllo delle impostazioni. Restituisce { ok, value } oppure { ok: false, error, field }. */
export function checkPricingSettings(input) {
  const bad = (error, field) => ({ ok: false, error, field });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Impostazioni non valide');
  const int = (v, min, max) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const d = DEFAULT_PRICING;
  const v = {};
  v.week_start = int(input.week_start ?? d.week_start, 0, 6);
  if (v.week_start === null) return bad('Giorno di inizio della settimana non valido', 'week_start');
  const m = input.months ?? d.months;
  if (!Array.isArray(m) || m.length !== 2) return bad('Mesi della stagione non validi', 'months');
  v.months = [int(m[0], 1, 12), int(m[1], 1, 12)];
  if (v.months.includes(null) || v.months[0] > v.months[1]) return bad('Stagione: il primo mese deve venire prima dell’ultimo', 'months');
  const disc = input.discounts ?? d.discounts;
  if (!disc || typeof disc !== 'object') return bad('Sconti non validi', 'discounts');
  v.discounts = {};
  for (const ch of ['airbnb', 'booking']) {
    v.discounts[ch] = int(disc[ch] ?? 0, 0, 50);
    if (v.discounts[ch] === null) return bad(`Sconto su ${ch === 'airbnb' ? 'Airbnb' : 'Booking'}: da 0 a 50%`, 'discounts');
  }
  v.floor_cents = int(input.floor_cents ?? 0, 0, 10000000);
  if (v.floor_cents === null) return bad('Netto minimo non valido', 'floor_cents');
  v.hold_days = int(input.hold_days ?? d.hold_days, 0, 365);
  if (v.hold_days === null) return bad('Giorni senza sconti: da 0 a 365', 'hold_days');
  const lm = input.last_minute ?? [];
  if (!Array.isArray(lm) || lm.length > 5) return bad('Ultimo minuto: al massimo 5 scaglioni', 'last_minute');
  v.last_minute = [];
  for (const x of lm) {
    const days = int(x && x.days, 1, 365);
    const pct = int(x && x.pct, 0, 50);
    if (days === null || pct === null) return bad('Ultimo minuto: giorni da 1 a 365, sconto da 0 a 50%', 'last_minute');
    if (pct > 0) v.last_minute.push({ days, pct });
  }
  v.last_minute.sort((a, b) => b.days - a.days);
  if (new Set(v.last_minute.map((x) => x.days)).size !== v.last_minute.length) return bad('Ultimo minuto: due scaglioni con gli stessi giorni', 'last_minute');
  const p = input.pace ?? d.pace;
  if (!p || typeof p !== 'object') return bad('Ritmo non valido', 'pace');
  v.pace = { gap_pts: int(p.gap_pts ?? d.pace.gap_pts, 1, 100), up_pct: int(p.up_pct ?? 0, 0, 50), down_pct: int(p.down_pct ?? 0, 0, 50) };
  if (Object.values(v.pace).includes(null)) return bad('Ritmo: punti da 1 a 100, percentuali da 0 a 50', 'pace');
  return { ok: true, value: v };
}

/* ------------------------------ Settimane ------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

/** Primo e ultimo giorno (escluso) della stagione di un anno. */
export function seasonBounds(year, settings) {
  const [a, b] = settings.months;
  const start = `${year}-${pad(a)}-01`;
  const end = b === 12 ? `${year + 1}-01-01` : `${year}-${pad(b + 1)}-01`;
  return { start, end };
}

/**
 * Settimane della stagione: iniziano nel giorno scelto (di solito sabato) e contano se almeno 4 delle 7 notti
 * cadono nella stagione. Restituisce le date di inizio ('AAAA-MM-GG').
 */
export function seasonWeeks(year, settings) {
  const { start, end } = seasonBounds(year, settings);
  let w = addDays(start, -((weekday(start) - settings.week_start + 7) % 7));
  const out = [];
  for (; w < end; w = addDays(w, 7)) {
    const from = w > start ? w : start;
    const to = addDays(w, 7) < end ? addDays(w, 7) : end;
    if (daysBetween(from, to) >= 4) out.push(w);
  }
  return out;
}

/** Anno della stagione da mostrare: quella in corso o, finita la stagione, quella dell'anno dopo. */
export function seasonYear(today, settings) {
  const y = Number(today.slice(0, 4));
  return Number(today.slice(5, 7)) > settings.months[1] ? y + 1 : y;
}

/** Mese (1-12) a cui appartiene una settimana: quello che contiene la maggior parte delle notti. */
export function weekMonth(ws) {
  return Number(addDays(ws, 3).slice(5, 7));
}

/* ------------------------------ Listino salvato ------------------------------ */

/** Netti salvati di una casa e un anno: { 'AAAA-MM-GG': centesimi }. */
export function listWeeks(prices, houseId, year) {
  const rec = (prices || []).find((p) => p.house_id === houseId && p.year === year);
  if (!rec) return {};
  let w = rec.weeks;
  if (typeof w === 'string') {
    try { w = JSON.parse(w); } catch { w = {}; }
  }
  return w && typeof w === 'object' ? w : {};
}

/** Controllo dei netti inviati (server e app). weeks: { data: centesimi | null }. */
export function checkWeekChanges(year, weeks) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return { ok: false, error: 'Anno non valido' };
  if (!weeks || typeof weeks !== 'object' || Array.isArray(weeks)) return { ok: false, error: 'Prezzi non validi' };
  const entries = Object.entries(weeks);
  if (!entries.length || entries.length > 60) return { ok: false, error: 'Da 1 a 60 settimane per volta' };
  const out = {};
  for (const [k, c] of entries) {
    // La prima settimana può iniziare a fine dell'anno prima (stagione da gennaio).
    if (!isIsoDate(k) || k < `${year - 1}-12-20` || k > `${year}-12-31`) return { ok: false, error: `Settimana non valida: ${k}` };
    if (c === null) { out[k] = null; continue; }
    if (!Number.isSafeInteger(c) || c < 100 || c > 10000000) return { ok: false, error: 'Prezzo della settimana non valido (da 1 € a 100.000 €)' };
    out[k] = c;
  }
  return { ok: true, value: out };
}

/** Netto della settimana che contiene la notte `date` (null se nel listino non c'è). */
export function weekForNight(weeks, date) {
  let best = null;
  for (const k of Object.keys(weeks)) if (k <= date && date < addDays(k, 7) && (!best || k > best)) best = k;
  return best;
}

/* ------------------------------ Prezzi per canale ------------------------------ */

/** Su ogni canale, quanto resta in tasca di 1 € pagato dall'ospite (in centesimi di punto): 10000 − commissione − cedolare. */
export function keepBp(acc, channel, date) {
  const rule = channelRule(acc, channel, date);
  return 10000 - (channel === 'diretto' ? 0 : effectiveBp(rule)) - acc.cedolare_bp;
}

const ceilEuro = (cents) => Math.ceil(cents / 100 - 1e-9) * 100;

/**
 * Prezzi da mettere su ogni canale perché in tasca resti il netto della settimana.
 * Il prezzo a notte si arrotonda all'euro in su (così il netto non scende mai sotto quello scelto).
 * Con uno sconto attivo sul portale (es. Genius) il prezzo da inserire è più alto: dopo lo sconto torna giusto.
 * Restituisce { diretto: {...}, airbnb: {...}, booking: {...} } con:
 *   night (da inserire, a notte), week (7 notti), guestNight (pagato dall'ospite dopo lo sconto),
 *   commissionBp (commissione con IVA), keepWeek (in tasca davvero con quel prezzo), discount (%).
 */
export function channelPrices(netWeekCents, { acc, date, discounts = {} }) {
  const out = {};
  for (const ch of CHANNEL_ORDER) {
    const keep = keepBp(acc, ch, date);
    if (!(netWeekCents > 0) || keep <= 0) { out[ch] = null; continue; }
    const disc = ch === 'diretto' ? 0 : discounts[ch] || 0;
    const grossNight = (netWeekCents / 7) * 10000 / keep;
    const night = ceilEuro(grossNight / (1 - disc / 100));
    const guestNight = Math.round(night * (1 - disc / 100));
    const keepWeek = Math.round((guestNight * 7 * keep) / 10000);
    const rule = channelRule(acc, ch, date);
    out[ch] = { night, week: night * 7, guestNight, keepWeek, discount: disc, commissionBp: ch === 'diretto' ? 0 : effectiveBp(rule), withheld: Boolean(rule.withheld) };
  }
  return out;
}

/** Prezzo in diretta (quello del preventivo) per le notti da checkIn a checkOut, dal listino. null se manca qualche notte. */
export function directPriceFromList(weeks, { checkIn, checkOut, acc }) {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn) return null;
  let total = 0;
  const used = new Set();
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    const k = weekForNight(weeks, d);
    if (!k || !(weeks[k] > 0)) return null;
    used.add(k);
    total += channelPrices(weeks[k], { acc, date: k }).diretto.night;
  }
  return { total, weeks: [...used].sort() };
}

/* ------------------------------ Storico ------------------------------ */

/**
 * Netto in tasca della stessa settimana k anni fa (52 settimane per anno: stesso giorno della settimana).
 * Media pesata sulle notti vendute in quella settimana, riportata a 7 notti. Usa le regole della contabilità
 * valide allora (es. Airbnb al 3% prima del 13/10/2026). Restituisce { net, nights, stays } o null.
 */
export function weekHistory(bookings, house, ws, k = 1, extras = []) {
  const acc = accountingSettings(house);
  const from = addDays(ws, -364 * k);
  const to = addDays(from, 7);
  let sum = 0;
  let nights = 0;
  const stays = [];
  for (const b of bookings) {
    if (b.house_id !== house.id || b.stage === 'cancellata' || !(b.total_cents > 0)) continue;
    if (!(b.check_in < to && b.check_out > from)) continue;
    const a = stayAccount(b, { extras, settings: acc });
    if (!a.nights) continue;
    const perNight = (a.price - a.commission - a.cedolare) / a.nights;
    const inWeek = daysBetween(b.check_in > from ? b.check_in : from, b.check_out < to ? b.check_out : to);
    sum += perNight * inWeek;
    nights += inWeek;
    stays.push({ id: b.id, channel: b.channel, check_in: b.check_in, check_out: b.check_out, price: a.price, nights: a.nights });
  }
  if (!nights) return null;
  return { net: Math.round((sum / nights) * 7), nights, stays, from };
}

/* ------------------------------ Ritmo delle prenotazioni ------------------------------ */

/**
 * Giorno in cui è arrivata una prenotazione: "prenotata il" se c'è; altrimenti il giorno in cui è stata inserita,
 * ma solo se prima dell'arrivo (le prenotazioni importate dopo il soggiorno non dicono quando sono arrivate).
 */
export function bookedOn(b) {
  if (isIsoDate(b.booked_on)) return b.booked_on;
  const c = typeof b.created_at === 'string' ? b.created_at.slice(0, 10) : null;
  return isIsoDate(c) && c <= b.check_in ? c : null;
}

function nightsInMonth(b, year, month) {
  const a = `${year}-${pad(month)}-01`;
  const z = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  const from = b.check_in > a ? b.check_in : a;
  const to = b.check_out < z ? b.check_out : z;
  return Math.max(0, daysBetween(from, to));
}

const daysIn = (year, month) => daysBetween(`${year}-${pad(month)}-01`, month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`);

/** Stesso giorno un anno prima (29 febbraio → 28). */
function yearBefore(iso) {
  const md = iso.slice(5) === '02-29' ? '02-28' : iso.slice(5);
  return `${Number(iso.slice(0, 4)) - 1}-${md}`;
}

/**
 * Ritmo delle prenotazioni per ogni mese della stagione: notti vendute oggi (in %) contro le notti che a questa
 * stessa data dell'anno scorso erano già vendute. status: 'avanti' | 'in_linea' | 'indietro' | null (anno scorso
 * senza date di prenotazione: non si può confrontare).
 */
export function bookingPace(bookings, houseId, year, settings, today) {
  const mine = bookings.filter((b) => b.house_id === houseId && b.stage !== 'cancellata');
  const sameDayLy = yearBefore(today);
  const months = [];
  for (let m = settings.months[0]; m <= settings.months[1]; m++) {
    const cap = daysIn(year, m);
    const capLy = daysIn(year - 1, m);
    let sold = 0;
    let ly = 0;
    let lyFinal = 0;
    let lyUnknown = 0;
    for (const b of mine) {
      const n = nightsInMonth(b, year, m);
      if (n) sold += n;
      const nl = nightsInMonth(b, year - 1, m);
      if (!nl) continue;
      lyFinal += nl;
      const bo = bookedOn(b);
      if (!bo) lyUnknown += nl;
      else if (bo <= sameDayLy) ly += nl;
    }
    const pct = Math.round((sold / cap) * 100);
    const lyPct = Math.round((ly / capLy) * 100);
    const comparable = lyFinal > 0 && lyUnknown === 0;
    const diff = pct - lyPct;
    const status = !comparable ? null : diff >= settings.pace.gap_pts ? 'avanti' : diff <= -settings.pace.gap_pts ? 'indietro' : 'in_linea';
    months.push({ month: m, cap, sold, pct, ly, lyPct, lyFinalPct: Math.round((lyFinal / capLy) * 100), lyUnknown, comparable, diff, status });
  }
  return months;
}

/* ------------------------------ Suggerimenti ------------------------------ */

const round10 = (cents) => Math.round(cents / 1000) * 1000;

/** Notti già vendute nella settimana che inizia in ws. */
export function soldNights(bookings, houseId, ws) {
  const to = addDays(ws, 7);
  let n = 0;
  for (const b of bookings) {
    if (b.house_id !== houseId || b.stage === 'cancellata' || !(b.check_in < to && b.check_out > ws)) continue;
    n += daysBetween(b.check_in > ws ? b.check_in : ws, b.check_out < to ? b.check_out : to);
  }
  return n;
}

/**
 * Suggerimento per una settimana (solo un consiglio: il prezzo lo cambia Mattia).
 * Niente per settimane già iniziate o con notti già vendute.
 *  - manca il prezzo: si propone quello dell'anno scorso;
 *  - oltre hold_days dall'arrivo niente sconti (si tiene il prezzo), solo l'aumento se il mese va più veloce;
 *  - più vicino: sconto di ultimo minuto (lo scaglione più forte raggiunto), ritmo lento −, ritmo veloce +.
 * Restituisce null oppure { target, pct, reasons: [{ text, pct }], missing }.
 */
export function weekSuggestion({ ws, net, lyNet, sold, pace, today, settings }) {
  if (ws <= today || sold > 0) return null;
  if (!(net > 0)) {
    if (lyNet > 0) return { missing: true, target: Math.max(settings.floor_cents, round10(lyNet)), pct: 0, reasons: [{ text: 'Manca il prezzo: si parte da quello dell’anno scorso', pct: 0 }] };
    return null;
  }
  const days = daysBetween(today, ws);
  const reasons = [];
  const name = MONTHS_LONG[(pace ? pace.month : weekMonth(ws)) - 1];
  const Name = name[0].toUpperCase() + name.slice(1);
  if (days <= settings.hold_days) {
    const step = settings.last_minute.filter((x) => days <= x.days).sort((a, b) => b.pct - a.pct)[0];
    if (step) reasons.push({ text: `Arrivo tra ${days} ${days === 1 ? 'giorno' : 'giorni'} e settimana ancora da vendere`, pct: -step.pct });
    if (pace && pace.status === 'indietro' && settings.pace.down_pct) {
      reasons.push({ text: `${Name} va più lento dell’anno scorso (${pace.pct}% venduto, l’anno scorso a oggi ${pace.lyPct}%)`, pct: -settings.pace.down_pct });
    }
  }
  if (pace && pace.status === 'avanti' && settings.pace.up_pct) {
    reasons.push({ text: `${Name} va più veloce dell’anno scorso (${pace.pct}% venduto, l’anno scorso a oggi ${pace.lyPct}%)`, pct: settings.pace.up_pct });
  }
  const pct = reasons.reduce((s, x) => s + x.pct, 0);
  if (!pct) return null;
  const target = Math.max(settings.floor_cents, round10(net * (1 + pct / 100)));
  if (target === net) return null;
  return { missing: false, target, pct, reasons };
}

/**
 * Tutto quello che serve alla pagina per una casa e una stagione.
 * Restituisce { year, weeks: [{ ws, net, prices, ly, ly2, sold, suggestion }], pace, acc, settings }.
 */
export function buildList({ bookings, prices, extras = [], house, year, today }) {
  const settings = pricingSettings(house);
  const acc = accountingSettings(house);
  const saved = listWeeks(prices, house.id, year);
  const pace = bookingPace(bookings, house.id, year, settings, today);
  const weeks = seasonWeeks(year, settings).map((ws) => {
    const net = saved[ws] > 0 ? saved[ws] : null;
    const ly = weekHistory(bookings, house, ws, 1, extras);
    const ly2 = weekHistory(bookings, house, ws, 2, extras);
    const sold = soldNights(bookings, house.id, ws);
    const p = pace.find((x) => x.month === weekMonth(ws)) || null;
    return {
      ws, net, sold, ly, ly2,
      prices: net ? channelPrices(net, { acc, date: ws, discounts: settings.discounts }) : null,
      suggestion: weekSuggestion({ ws, net, lyNet: ly && ly.net, sold, pace: p, today, settings }),
    };
  });
  return { year, weeks, pace, acc, settings, saved };
}

/** Quanti suggerimenti ci sono (per il promemoria del lunedì). */
export function suggestionCount(list) {
  return list.weeks.filter((w) => w.suggestion).length;
}
