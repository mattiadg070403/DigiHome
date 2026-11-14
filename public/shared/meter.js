// Contatore della luce: letture all'arrivo e alla partenza, kWh compresi e kWh in più da incassare.
// Le letture si salvano in decimi di kWh (interi): 12.345,6 kWh → 123456.

import { daysBetween, formatItDate, timeRome, todayRome } from './dates.js';
import { fmtEuro } from './money.js';
import { euroEn } from './contract-en.js';

const MAX = 999999999;

/** Da testo a decimi di kWh. Accetta "12345", "12345,6", "12.345", "12.345,6", "12345.6". null se non valido. */
export function parseKwh(text) {
  const s = String(text ?? '').trim().replace(/\s/g, '').replace(/kwh$/i, '');
  if (!s || !/^\d[\d.,]*$/.test(s)) return null;
  let int = s;
  let dec = '';
  if (s.includes(',')) {
    if ((s.match(/,/g) || []).length > 1) return null;
    [int, dec] = s.split(',');
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(int)) return null;
  } else if (/^\d+\.\d$/.test(s)) {
    [int, dec] = s.split('.');
  } else if (s.includes('.') && !/^\d{1,3}(\.\d{3})+$/.test(s)) {
    return null;
  }
  if (dec.length > 1) return null;
  const n = Number(int.replace(/\./g, '')) * 10 + Number(dec || 0);
  return Number.isSafeInteger(n) && n <= MAX ? n : null;
}

/** Fasce del contatore: il display mostra A1, A2 e A3, che si sommano. */
export const BANDS = ['A1', 'A2', 'A3'];

/** Fasce salvate (JSON) → [a1, a2, a3] in decimi di kWh, oppure null. */
export function bandsOf(json) {
  if (!json) return null;
  try {
    const v = typeof json === 'string' ? JSON.parse(json) : json;
    return Array.isArray(v) && v.length === 3 && v.every((x) => Number.isSafeInteger(x) && x >= 0) ? v : null;
  } catch {
    return null;
  }
}

/** Decimi di kWh → "12.345,6" (senza ",0"). */
export function fmtKwh(tenths, lang = 'it') {
  if (!Number.isInteger(tenths)) return '';
  const int = Math.floor(tenths / 10);
  const dec = tenths % 10;
  const sep = lang === 'en' ? ',' : '.';
  const intText = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return dec ? `${intText}${lang === 'en' ? '.' : ','}${dec}` : intText;
}

/**
 * Conti del soggiorno. rules: { kwh_day, kwh_price_cents } (dai Dati del contratto della casa).
 * Restituisce { nights, included, limit, used, extra, cost } (kWh in decimi, costo in centesimi);
 * included/limit null se la luce è tutta compresa; used/extra/cost null finché manca una lettura.
 */
export function meterCalc(b, rules = {}) {
  const nights = Math.max(0, daysBetween(b.check_in, b.check_out));
  const perDay = Number.isInteger(rules.kwh_day) && rules.kwh_day > 0 ? rules.kwh_day : null;
  const included = perDay ? perDay * nights * 10 : null;
  const hasStart = Number.isInteger(b.meter_start);
  const hasEnd = Number.isInteger(b.meter_end);
  const out = { nights, perDay, included, limit: hasStart && included !== null ? b.meter_start + included : null, used: null, extra: null, cost: null };
  if (hasStart && hasEnd && b.meter_end >= b.meter_start) {
    out.used = b.meter_end - b.meter_start;
    if (included !== null) {
      out.extra = Math.max(0, out.used - included);
      out.cost = Math.round((out.extra * (rules.kwh_price_cents || 0)) / 10);
    }
  }
  return out;
}

/** Descrizione dell'extra della luce: "45,3 kWh oltre i 210 compresi". */
export function meterExtraLabel(calc) {
  return `${fmtKwh(calc.extra)} kWh oltre i ${fmtKwh(calc.included)} compresi`;
}

/** Righe "A1: 1.234 kWh" … "Totale: 7.035 kWh" (se le fasce ci sono). */
function bandLines(json, total, lang) {
  const bands = bandsOf(json);
  if (!bands) return [];
  return [...bands.map((x, i) => `${BANDS[i]}: ${fmtKwh(x, lang)} kWh`), `${lang === 'en' ? 'Total' : 'Totale'}: ${fmtKwh(total, lang)} kWh`];
}

function when(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = formatItDate(todayRome(d));
  return lang === 'en' ? `${date} at ${timeRome(d)}` : `${date} alle ${timeRome(d)}`;
}

/**
 * Messaggio per l'ospite con la lettura appena fatta (all'arrivo o alla partenza).
 * which: 'start' | 'end'; rules: kWh compresi e prezzo.
 */
export function meterMessage(which, b, rules = {}, lang = 'it') {
  const en = lang === 'en';
  const c = meterCalc(b, rules);
  const name = String(b.guest_name || '').replace(/\s*\(prova\)$/, '').trim().split(/\s+/)[0];
  const price = en ? euroEn(rules.kwh_price_cents || 0) : fmtEuro(rules.kwh_price_cents || 0);
  const L = [];
  L.push(en ? `Hi ${name || 'there'},` : `Ciao ${name || ''},`.replace(' ,', ','));
  if (which === 'start') {
    const lines = bandLines(b.meter_start_bands, b.meter_start, lang);
    if (lines.length) {
      L.push(en ? `here is the electricity meter reading on arrival (${when(b.meter_start_at, 'en')}):` : `ti invio la lettura del contatore della luce all’arrivo (${when(b.meter_start_at, 'it')}):`, ...lines);
    } else {
      L.push(en
        ? `here is the electricity meter reading on arrival: ${fmtKwh(b.meter_start, 'en')} kWh (${when(b.meter_start_at, 'en')}).`
        : `ti invio la lettura del contatore della luce all’arrivo: ${fmtKwh(b.meter_start)} kWh (${when(b.meter_start_at, 'it')}).`);
    }
    if (c.included !== null) {
      L.push(en
        ? `${c.perDay} kWh per day are included, i.e. ${fmtKwh(c.included, 'en')} kWh for the ${c.nights} nights of your stay. If on departure the total is above ${fmtKwh(c.limit, 'en')} kWh, each extra kWh costs ${price} and is paid on departure.`
        : `Sono compresi ${c.perDay} kWh al giorno, cioè ${fmtKwh(c.included)} kWh per le ${c.nights} notti del soggiorno. Se alla partenza il totale supera ${fmtKwh(c.limit)} kWh, ogni kWh in più costa ${price} e si paga alla partenza.`);
    }
  } else {
    const lines = bandLines(b.meter_end_bands, b.meter_end, lang);
    if (lines.length) {
      L.push(en ? `here is the electricity meter reading on departure (${when(b.meter_end_at, 'en')}):` : `ti invio la lettura del contatore della luce alla partenza (${when(b.meter_end_at, 'it')}):`, ...lines);
      L.push(en ? `On arrival the total was ${fmtKwh(b.meter_start, 'en')} kWh.` : `All’arrivo il totale era ${fmtKwh(b.meter_start)} kWh.`);
    } else {
      L.push(en
        ? `here is the electricity meter reading on departure: ${fmtKwh(b.meter_end, 'en')} kWh (${when(b.meter_end_at, 'en')}); on arrival it was ${fmtKwh(b.meter_start, 'en')} kWh.`
        : `ti invio la lettura del contatore della luce alla partenza: ${fmtKwh(b.meter_end)} kWh (${when(b.meter_end_at, 'it')}); all’arrivo era ${fmtKwh(b.meter_start)} kWh.`);
    }
    if (c.used !== null) {
      if (c.included === null) L.push(en ? `Consumption: ${fmtKwh(c.used, 'en')} kWh, included in the price.` : `Consumo: ${fmtKwh(c.used)} kWh, compreso nel prezzo.`);
      else if (c.extra > 0) {
        const cost = en ? euroEn(c.cost) : fmtEuro(c.cost);
        L.push(en
          ? `Consumption: ${fmtKwh(c.used, 'en')} kWh; ${fmtKwh(c.included, 'en')} kWh were included, so ${fmtKwh(c.extra, 'en')} extra kWh × ${price} = ${cost}.`
          : `Consumo: ${fmtKwh(c.used)} kWh; erano compresi ${fmtKwh(c.included)} kWh, quindi ${fmtKwh(c.extra)} kWh in più × ${price} = ${cost}.`);
      } else {
        L.push(en
          ? `Consumption: ${fmtKwh(c.used, 'en')} kWh, within the ${fmtKwh(c.included, 'en')} kWh included: nothing extra to pay.`
          : `Consumo: ${fmtKwh(c.used)} kWh, entro i ${fmtKwh(c.included)} kWh compresi: niente da pagare in più.`);
      }
    }
  }
  return L.join('\n');
}
