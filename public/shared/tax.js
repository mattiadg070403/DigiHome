// Tassa di soggiorno: tariffe per mese (a persona a notte) e calcolo. Usato da app e server.
// Le tariffe si cambiano in Impostazioni → Case. Importi sempre in centesimi.

import { addDays, isIsoDate } from './dates.js';
import { fmtEuro } from './money.js';

export const MONTHS_SHORT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

/** Tariffe di partenza (Gallipoli): maggio e ottobre 0,50 €, da giugno a settembre 1 €, altri mesi niente. */
export const DEFAULT_TAX = { rates: [0, 0, 0, 0, 50, 100, 100, 100, 100, 50, 0, 0], max_nights: null };

const MAX_RATE = 10000; // 100 € a persona a notte: oltre è sicuramente un errore di battitura

/** Impostazioni della tassa di una casa (dal testo salvato), sempre valide. */
export function taxSettings(house) {
  let raw = house && house.tourist_tax;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const ok = checkTaxSettings(raw);
  return ok.ok ? ok.value : { rates: [...DEFAULT_TAX.rates], max_nights: null };
}

/** Controlla le impostazioni inviate. Restituisce { ok, value } oppure { ok: false, error }. */
export function checkTaxSettings(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.rates) || input.rates.length !== 12) {
    return { ok: false, error: 'Servono le tariffe dei 12 mesi.' };
  }
  const rates = input.rates.map(Number);
  if (rates.some((r) => !Number.isSafeInteger(r) || r < 0 || r > MAX_RATE)) return { ok: false, error: 'Tariffa non valida (da 0 a 100 € a persona a notte).' };
  let max = input.max_nights;
  if (max === '' || max === undefined || max === null) max = null;
  else {
    max = Number(max);
    if (!Number.isInteger(max) || max < 1 || max > 365) return { ok: false, error: 'Numero massimo di notti non valido.' };
  }
  return { ok: true, value: { rates, max_nights: max } };
}

/**
 * Calcolo per un soggiorno: ogni notte usa la tariffa del suo mese; con max_nights si contano solo le prime notti.
 * Restituisce { amount, perPerson, parts: [{ rate, nights }], nights, counted }.
 */
export function touristTax(checkIn, checkOut, persons, settings) {
  const out = { amount: 0, perPerson: 0, parts: [], nights: 0, counted: 0 };
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn) return out;
  const p = Math.max(0, Math.floor(Number(persons) || 0));
  const byRate = new Map();
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    out.nights += 1;
    if (settings.max_nights && out.counted >= settings.max_nights) continue;
    out.counted += 1;
    const rate = settings.rates[Number(d.slice(5, 7)) - 1] || 0;
    out.perPerson += rate;
    if (rate > 0) byRate.set(rate, (byRate.get(rate) || 0) + 1);
  }
  out.parts = [...byRate.entries()].sort((a, b) => b[0] - a[0]).map(([rate, nights]) => ({ rate, nights }));
  out.amount = out.perPerson * p;
  return out;
}

/** Spiegazione del calcolo: "2 persone × (4 notti × 1 € + 3 notti × 0,50 €) = 11 €". */
export function explainTax(calc, persons) {
  if (!calc.nights) return 'Scegli le date per calcolare la tassa.';
  if (!calc.perPerson) return 'In queste date non si paga la tassa di soggiorno.';
  const p = Math.max(0, Math.floor(Number(persons) || 0));
  const nightsText = calc.parts.map((x) => `${x.nights} ${x.nights === 1 ? 'notte' : 'notti'} × ${fmtEuro(x.rate)}`).join(' + ');
  const capped = calc.counted < calc.nights ? ` (contate le prime ${calc.counted} notti)` : '';
  return `${p} ${p === 1 ? 'persona' : 'persone'} × (${nightsText})${capped} = ${fmtEuro(calc.amount)}`;
}
