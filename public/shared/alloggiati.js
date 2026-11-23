// Regole degli ospiti e delle schedine di Alloggiati Web (Polizia di Stato), condivise da app, server e test.
//
// Tracciato ufficiale (manuale del servizio web, tabella 1): una riga di 168 caratteri per ospite.
//   Tipo alloggiato 2 · Data arrivo 10 (gg/mm/aaaa) · Giorni di permanenza 2 (max 30) · Cognome 50 · Nome 30 ·
//   Sesso 1 (1 = M, 2 = F) · Data di nascita 10 · Comune di nascita 9 · Provincia di nascita 2 · Stato di nascita 9 ·
//   Cittadinanza 9 · Tipo documento 5 · Numero documento 20 · Luogo di rilascio 9.
// Tipi: 16 ospite singolo, 17 capofamiglia, 18 capogruppo, 19 familiare, 20 membro del gruppo.
// Il documento serve solo per 16, 17 e 18. Familiari e membri vanno subito dopo il loro capo.
// Le schedine si possono inviare solo il giorno dell'arrivo o quello dopo.

import { addDays, nights as countNights } from './dates.js';

export const ITALY = '100000100';
export const RECORD_LENGTH = 168;
export const MAX_GUESTS = 30;
export const SEX = { M: 'Maschio', F: 'Femmina' };
export const GROUPS = { famiglia: 'Famiglia', gruppo: 'Gruppo' };

const isCode = (s) => typeof s === 'string' && /^\d{9}$/.test(s);
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Nomi come li vuole la Questura: maiuscole, senza accenti (À → A), solo lettere, spazi, apostrofo e trattino.
 * (Gli accenti e i simboli sono la prima causa di schedine rifiutate.)
 */
export function plainName(s) {
  return nameTranscription(s).text;
}

/**
 * Come il nome verrà scritto sulla schedina, e quali caratteri il portale non accetta (tolti).
 * Gli accenti si tolgono senza perdere la lettera (À → A); i caratteri di altri alfabeti o i simboli invece
 * si perdono: in quel caso l'app avvisa di scrivere il nome in lettere latine, come sul passaporto.
 */
export function nameTranscription(s) {
  const out = [];
  const dropped = [];
  for (const ch of String(s ?? '').normalize('NFD')) {
    const c = ch.codePointAt(0);
    if (c >= 0x300 && c <= 0x36f) continue; // segni degli accenti
    const up = ch.toUpperCase();
    const u = up.codePointAt(0);
    if ((u >= 65 && u <= 90) || up === ' ' || up === "'" || up === '-') out.push(up);
    else if (ch === '’' || ch === '`' || ch === '‘') out.push("'");
    else if (ch === 'Ø' || ch === 'ø') out.push('O');
    else if (ch === 'Æ' || ch === 'æ') out.push('AE');
    else if (ch === 'Œ' || ch === 'œ') out.push('OE');
    else if (ch === 'Ł' || ch === 'ł') out.push('L');
    else if (ch === 'Đ' || ch === 'đ') out.push('D');
    else if (ch === 'Þ' || ch === 'þ') out.push('TH');
    else if (ch === 'ı') out.push('I');
    else if (/\s/.test(ch)) out.push(' ');
    else { dropped.push(ch); out.push(' '); }
  }
  return { text: out.join('').replace(/ +/g, ' ').trim(), dropped };
}

/** Numero del documento: maiuscole, lettere e numeri. */
export function plainDoc(s) {
  return String(s ?? '').toUpperCase().split('').filter((ch) => /[A-Z0-9]/.test(ch)).join('');
}

/** Caratteri del numero di documento che non arrivano alla Questura (diversi da spazi e trattini). */
export function docDropped(s) {
  return String(s ?? '').toUpperCase().split('').filter((ch) => !/[A-Z0-9\s-]/.test(ch));
}

/** Età compiuta in una data. */
export function ageOn(birth, on) {
  if (!isIso(birth) || !isIso(on)) return null;
  const [by, bm, bd] = birth.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Tipo di schedina per l'ospite in quella posizione. */
export function guestType(position, count, group) {
  if (count <= 1) return '16';
  if (position === 0) return group === 'gruppo' ? '18' : '17';
  return group === 'gruppo' ? '20' : '19';
}

export const TYPE_LABEL = { 16: 'Ospite singolo', 17: 'Capofamiglia', 18: 'Capogruppo', 19: 'Familiare', 20: 'Membro del gruppo' };

/** Cosa manca a un ospite (testi brevi). leader: capofamiglia/capogruppo/singolo (serve il documento). */
export function guestMissing(g, leader, { today } = {}) {
  const miss = [];
  if (!plainName(g.last_name)) miss.push('cognome');
  if (!plainName(g.first_name)) miss.push('nome');
  if (!SEX[g.sex]) miss.push('sesso');
  if (!isIso(g.birth_date) || (today && g.birth_date > today)) miss.push('data di nascita');
  if (!isCode(g.birth_place)) miss.push('luogo di nascita');
  if (!isCode(g.citizenship)) miss.push('cittadinanza');
  if (!isCode(g.residence)) miss.push('residenza');
  if (leader) {
    if (!g.doc_type) miss.push('tipo di documento');
    if (!plainDoc(g.doc_number)) miss.push('numero del documento');
    if (!isCode(g.doc_place)) miss.push('luogo di rilascio');
  }
  return miss;
}

/** Le schedine si possono inviare solo il giorno dell'arrivo o quello dopo. */
export function sendWindow(checkIn, today) {
  if (checkIn === today) return { ok: true, last: addDays(today, 1) };
  if (checkIn === addDays(today, -1)) return { ok: true, last: today };
  if (checkIn > today) return { ok: false, reason: 'early', text: `Si possono inviare dal giorno dell’arrivo.` };
  return { ok: false, reason: 'late', text: 'Il portale accetta solo arrivi di oggi o di ieri: per un arrivo più vecchio serve la Questura (PEC).' };
}

const pad = (s, n) => {
  const v = String(s ?? '');
  if (v.length > n) throw new Error(`campo troppo lungo (${n})`);
  return v + ' '.repeat(n - v.length);
};
const itDate = (iso) => iso.split('-').reverse().join('/');

/**
 * Riga della schedina (168 caratteri). places: funzione codice → { kind: 'C'|'S', province }.
 * Lancia un errore se manca qualcosa (le schedine incomplete non partono mai).
 */
export function schedina(g, { type, checkIn, checkOut, place }) {
  const leader = ['16', '17', '18'].includes(type);
  const miss = guestMissing(g, leader);
  if (miss.length) throw new Error(`Mancano: ${miss.join(', ')}`);
  const days = Math.min(30, Math.max(1, countNights(checkIn, checkOut)));
  const birth = place(g.birth_place);
  if (!birth) throw new Error('Luogo di nascita non trovato nelle tabelle ufficiali: sceglilo di nuovo dall’elenco');
  const bornInItaly = birth.kind === 'C';
  const docPlace = leader ? place(g.doc_place) : null;
  if (leader && !docPlace) throw new Error('Luogo di rilascio non trovato nelle tabelle ufficiali: sceglilo di nuovo dall’elenco');
  const row = [
    pad(type, 2),
    pad(itDate(checkIn), 10),
    pad(String(days).padStart(2, '0'), 2),
    pad(plainName(g.last_name).slice(0, 50), 50),
    pad(plainName(g.first_name).slice(0, 30), 30),
    g.sex === 'M' ? '1' : '2',
    pad(itDate(g.birth_date), 10),
    pad(bornInItaly ? g.birth_place : '', 9),
    pad(bornInItaly ? (birth.province || '') : '', 2),
    pad(bornInItaly ? ITALY : g.birth_place, 9),
    pad(g.citizenship, 9),
    pad(leader ? g.doc_type : '', 5),
    pad(leader ? plainDoc(g.doc_number).slice(0, 20) : '', 20),
    pad(leader ? g.doc_place : '', 9),
  ].join('');
  if (row.length !== RECORD_LENGTH) throw new Error('Schedina di lunghezza sbagliata');
  return row;
}

/** Tutte le schedine di una prenotazione, capo per primo. */
export function bookingSchedine(b, guests, place) {
  const list = [...guests].filter((g) => !g.deleted).sort((x, y) => x.position - y.position);
  return list.map((g, i) => {
    const type = guestType(i, list.length, b.guest_group);
    try {
      return { guest: g, type, row: schedina(g, { type, checkIn: b.check_in, checkOut: b.check_out, place }) };
    } catch (e) {
      throw new Error(`${g.first_name} ${g.last_name}: ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)}`);
    }
  });
}
