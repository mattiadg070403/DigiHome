// Ricevuta del saldo per le prenotazioni dirette (versione 0.15).
// Scelte di Mattia (23/11/2026): facoltativa per casa, solo l'importo del saldo all'arrivo, nota della marca da bollo,
// in italiano e in inglese. Non è un consiglio fiscale: diciture da confermare con il commercialista.
// Usato dall'app (testo del PDF) e dal server (controlli).

import { formatItDate } from './dates.js';

/** Sopra questo importo (77,47 €) sulla ricevuta senza IVA va la marca da bollo da 2 €. */
export const STAMP_THRESHOLD_CENTS = 7747;

/** "1.600,00 €" (sempre con i centesimi, come si usa sulle ricevute). */
export function euroIt(cents) {
  const c = Math.abs(cents);
  return `${String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(c % 100).padStart(2, '0')} €`;
}

/** "€1,600.00" */
export function euroEnFull(cents) {
  const c = Math.abs(cents);
  return `€${String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(c % 100).padStart(2, '0')}`;
}

const enDate = (iso) => {
  const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${M[m - 1]} ${y}`;
};

/** Codice fiscale di una persona: 16 lettere e numeri. */
export function isTaxCode(s) {
  return /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(String(s || ''));
}

/**
 * Testo della ricevuta, a blocchi (come il contratto): r = { number, year, amount_cents, issued_on, data }.
 * data: { landlord_name, landlord_sal, landlord_cf, landlord_residence, city, address, cin, guest_name, check_in, check_out, method }.
 * ** ** = grassetto.
 */
export function receiptBlocks(r, lang = 'it') {
  const d = r.data || {};
  r = { ...r, issued_on: r.issued_on || d.issued_on };
  const stamp = r.amount_cents > STAMP_THRESHOLD_CENTS;
  if (lang === 'en') {
    const method = d.method === 'contanti' ? 'cash' : d.method === 'bonifico' ? 'bank transfer' : null;
    return [
      { t: 'title', text: `RECEIPT No. ${r.number}/${r.year}` },
      { t: 'place', text: `${d.city}, ${enDate(r.issued_on)}` },
      { t: 'p', text: `I, the undersigned **${d.landlord_name}**${d.landlord_cf ? `, tax code **${d.landlord_cf}**` : ''}${d.landlord_residence ? `, resident in ${d.landlord_residence}` : ''}, `
        + `hereby acknowledge receipt from **${d.guest_name}** of the sum of **${euroEnFull(r.amount_cents)}** as the balance paid on arrival for the short-term tourist rental `
        + `of the property located at ${d.address}, ${d.city}${d.cin ? ` (CIN ${d.cin})` : ''}, for the stay from ${enDate(d.check_in)} to ${enDate(d.check_out)}.` },
      method ? { t: 'p', text: `Payment method: ${method}.` } : null,
      { t: 'p', text: 'Transaction outside the scope of VAT. Landlord: private individual under the "cedolare secca" flat-rate tax regime.' },
      stamp ? { t: 'p', text: 'Stamp duty of €2.00 paid on the original (amount over €77.47).' } : null,
      { t: 'sign', label: 'The landlord', name: d.landlord_name },
    ].filter(Boolean);
  }
  const method = d.method === 'contanti' ? 'contanti' : d.method === 'bonifico' ? 'bonifico bancario' : null;
  const f = d.landlord_sal === 'F';
  return [
    { t: 'title', text: `RICEVUTA n. ${r.number}/${r.year}` },
    { t: 'place', text: `${d.city}, ${formatItDate(r.issued_on)}` },
    { t: 'p', text: `${f ? 'La sottoscritta' : 'Il sottoscritto'} **${d.landlord_name}**${d.landlord_cf ? `, codice fiscale **${d.landlord_cf}**` : ''}${d.landlord_residence ? `, residente in ${d.landlord_residence}` : ''}, `
      + `dichiara di aver ricevuto da **${d.guest_name}** la somma di **${euroIt(r.amount_cents)}** a saldo, all’arrivo, del corrispettivo per la locazione breve a uso turistico `
      + `dell’immobile sito in ${d.city}, ${d.address}${d.cin ? ` (CIN ${d.cin})` : ''}, per il soggiorno dal ${formatItDate(d.check_in)} al ${formatItDate(d.check_out)}.` },
    method ? { t: 'p', text: `Pagamento: ${method}.` } : null,
    { t: 'p', text: 'Operazione fuori campo IVA. Locatore persona fisica in regime di cedolare secca.' },
    stamp ? { t: 'p', text: 'Imposta di bollo di 2,00 € assolta sull’originale (importo superiore a 77,47 €).' } : null,
    { t: 'sign', label: f ? 'La locatrice' : 'Il locatore', name: d.landlord_name },
  ].filter(Boolean);
}

/** Nome del file: "Ricevuta 3-2027 Faro Blu - Verdi.pdf" / "Receipt …". */
export function receiptFileName(r, houseName, lang = 'it') {
  const simple = (s) => String(s || '').normalize('NFD').replace(/[^A-Za-z0-9 -]+/g, '').replace(/\s+/g, ' ').trim();
  const surname = simple((r.data && r.data.guest_name) || '').split(' ').slice(-1)[0] || 'ospite';
  return `${lang === 'en' ? 'Receipt' : 'Ricevuta'} ${r.number}-${r.year} ${simple(houseName) || 'casa'} - ${surname}.pdf`;
}
