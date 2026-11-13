// Contratto di locazione turistica: modello del testo e controlli, comuni ad app e server.
// Il testo vero di ogni contratto lo ricrea il server al momento della firma: l'app lo mostra soltanto.
// Solo per le prenotazioni dirette (con Airbnb e Booking valgono le loro condizioni).

import { addDays, formatItDate, isIsoDate, todayRome, timeRome } from './dates.js';
import { fmtEuro } from './money.js';
import { buildContractEn, guestParagraphEn } from './contract-en.js';

/** Lingue del contratto. */
export const LANGS = { it: 'Italiano', en: 'English' };

/** Versione del modello: si aumenta quando cambia il testo, così ogni contratto sa con quale è stato fatto. */
export const CONTRACT_TEMPLATE = 1;
/** Anni di conservazione dopo la partenza; poi il contratto si cancella da solo. */
export const KEEP_YEARS = 2;
/** Dimensione massima di una firma (immagine JPEG). */
export const MAX_SIGN_BYTES = 120 * 1024;

/* ------------------------------ Testo ammesso ------------------------------ */

// Il PDF usa i caratteri dell'alfabeto latino (Helvetica, codifica WinAnsi): lettere accentate italiane,
// francesi, tedesche, spagnole ecc. Lettere di altri alfabeti non si possono stampare: si chiede di
// scrivere i dati come sul documento in caratteri latini.
const WINANSI_EXTRA = new Set([0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178]);

export function isPrintable(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x20 && c <= 0x7E) || (c >= 0xA0 && c <= 0xFF) || WINANSI_EXTRA.has(c);
}

// Caratteri di controllo e invisibili (a capo esclusi): si tolgono sempre.
const INVISIBLE = [[0x00, 0x09], [0x0B, 0x1F], [0x7F, 0x9F], [0x200B, 0x200F], [0x2028, 0x202E], [0x2060, 0x206F], [0xFEFF, 0xFEFF]];
function isInvisible(c) {
  return INVISIBLE.some(([a, z]) => c >= a && c <= z);
}

/**
 * Pulisce un testo scritto a mano: spazi in più, caratteri di controllo; le lettere con segni
 * non stampabili (es. ł, ș) diventano la lettera semplice. Restituisce null se resta qualcosa
 * che non si può stampare (es. alfabeto cirillico).
 */
export function cleanText(input, { multiline = false } = {}) {
  let s = String(input ?? '').normalize('NFC');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/[\t\f\v]/g, ' ') : s.replace(/[\r\n\t\f\v]+/g, ' ');
  s = [...s].filter((ch) => !isInvisible(ch.codePointAt(0))).join('');
  // L'asterisco serve per il grassetto nel testo del contratto (**così**): nei dati scritti a mano non si usa.
  s = s.replace(/\*/g, '');
  const SIMPLE = { ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ı: 'i', ħ: 'h', Ħ: 'H', ŧ: 't', Ŧ: 'T' };
  let out = '';
  for (const ch of s) {
    if (ch === '\n' || isPrintable(ch)) { out += ch; continue; }
    const base = SIMPLE[ch] || [...ch.normalize('NFD')].filter((x) => { const c = x.codePointAt(0); return c < 0x300 || c > 0x36F; }).join('');
    if (base && [...base].every(isPrintable)) { out += base; continue; }
    return null;
  }
  out = multiline
    ? out.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : out.replace(/ {2,}/g, ' ').trim();
  return out;
}

/* --------------------------- Codice fiscale italiano --------------------------- */

const CF_ODD = { 0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21,
  K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23 };

/** Controlla forma e carattere di controllo del codice fiscale (anche con omocodia). */
export function isCodiceFiscale(cf) {
  const s = String(cf || '').toUpperCase();
  if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = s[i];
    if (i % 2 === 0) sum += CF_ODD[ch];
    else sum += /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26)) === s[15];
}

/* --------------------------- Dati del contratto per casa --------------------------- */

export const ROLES = {
  proprietario: ['proprietario', 'proprietaria'],
  comproprietario: ['comproprietario', 'comproprietaria'],
  usufruttuario: ['usufruttuario', 'usufruttuaria'],
  comodatario: ['comodatario', 'comodataria'],
};

// Campi di testo: [nome, etichetta, lunghezza massima, obbligatorio per poter firmare].
const INFO_TEXT = [
  ['landlord_name', 'Nome e cognome del locatore', 120, true],
  ['landlord_birth_place', 'Luogo di nascita del locatore', 80, true],
  ['landlord_residence', 'Residenza del locatore', 200, true],
  ['city', 'Comune dell’immobile', 60, true],
  ['address', 'Indirizzo dell’immobile', 160, true],
  ['description', 'Descrizione dell’immobile', 300, true],
  ['cin', 'Codice CIN', 30, true],
  ['quiet_hours', 'Orari di silenzio', 160, false],
  ['privacy_contact', 'Contatto per la privacy', 120, false],
  // Testi per il contratto in inglese (facoltativi: se mancano si usa quello italiano).
  ['description_en', 'Descrizione in inglese', 300, false],
  ['quiet_hours_en', 'Orari di silenzio in inglese', 160, false],
];

export function parseContractInfo(house) {
  if (!house || !house.contract_info) return {};
  try {
    const v = JSON.parse(house.contract_info);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Controllo dei dati del contratto di una casa. Restituisce { ok, value } oppure { ok: false, error, field }. */
export function checkContractInfo(input) {
  const bad = (error, field) => ({ ok: false, error, field });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Dati del contratto non validi');
  const v = {};
  v.landlord_sal = input.landlord_sal === 'F' ? 'F' : 'M';
  for (const [k, label, max] of INFO_TEXT) {
    const s = cleanText(input[k]);
    if (s === null) return bad(`${label}: usa solo caratteri latini`, k);
    if (s.length > max) return bad(`${label}: testo troppo lungo`, k);
    if (s) v[k] = s;
  }
  if (v.cin) {
    v.cin = v.cin.toUpperCase().replace(/\s+/g, '');
    if (!/^IT[0-9A-Z]{10,20}$/.test(v.cin)) return bad('Codice CIN non valido (inizia con IT)', 'cin');
  }
  if (input.landlord_birth_date) {
    if (!isIsoDate(input.landlord_birth_date) || input.landlord_birth_date < '1900-01-01') return bad('Data di nascita non valida', 'landlord_birth_date');
    v.landlord_birth_date = input.landlord_birth_date;
  }
  if (input.landlord_role) {
    if (!ROLES[input.landlord_role]) return bad('Scegli in che qualità affitti la casa', 'landlord_role');
    v.landlord_role = input.landlord_role;
  }
  const int = (k, label, min, max) => {
    const raw = input[k];
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return bad(`${label} non valido`, k);
    v[k] = n;
    return null;
  };
  const e = int('kwh_day', 'Numero di kWh', 1, 1000) || int('kwh_price_cents', 'Prezzo del kWh', 1, 1000) || int('advance_pct', 'Acconto', 1, 100);
  if (e) return e;
  if (v.kwh_day && !v.kwh_price_cents) return bad('Scrivi il prezzo dei kWh in più', 'kwh_price_cents');
  for (const k of ['extra_rules', 'extra_rules_en']) {
    const rules = cleanText(input[k], { multiline: true });
    if (rules === null) return bad('Regole della casa: usa solo caratteri latini', k);
    if (rules.length > 1500) return bad('Regole della casa: testo troppo lungo', k);
    if (rules) v[k] = rules;
  }
  return { ok: true, value: v };
}

/** Cosa manca per poter far firmare il contratto di questa casa (etichette da mostrare). */
export function contractMissing(info) {
  const out = [];
  for (const [k, label, , required] of INFO_TEXT) if (required && !info[k]) out.push(label);
  if (!info.landlord_birth_date) out.push('Data di nascita del locatore');
  if (!info.landlord_role) out.push('In qualità di (proprietario, usufruttuario…)');
  return out;
}

/* ------------------------------ Dati dell'ospite ------------------------------ */

export const GUEST_FIELDS = {
  name: 'Nome e cognome',
  birth_place: 'Luogo di nascita',
  birth_date: 'Data di nascita',
  residence: 'Residenza (indirizzo completo)',
  tax_code: 'Codice fiscale',
  doc_number: 'Numero del documento di identità',
};

/** Controllo dei dati del conduttore. today serve per controllare la maggiore età. */
export function checkGuest(input, today = todayRome()) {
  const bad = (error, field) => ({ ok: false, error, field });
  if (!input || typeof input !== 'object') return bad('Dati dell’ospite mancanti');
  const v = { sal: input.sal === 'F' ? 'F' : 'M' };
  const text = (k, min, max) => {
    const s = cleanText(input[k]);
    if (s === null) return bad(`${GUEST_FIELDS[k]}: scrivi in caratteri latini, come sul documento`, k);
    if (s.length < min) return bad(`Scrivi: ${GUEST_FIELDS[k].toLowerCase()}`, k);
    if (s.length > max) return bad(`${GUEST_FIELDS[k]}: testo troppo lungo`, k);
    v[k] = s;
    return null;
  };
  const e1 = text('name', 3, 120) || text('birth_place', 2, 80);
  if (e1) return e1;
  if (!isIsoDate(input.birth_date) || input.birth_date < '1900-01-01') return bad('Scrivi la data di nascita', 'birth_date');
  const [y, m, d] = today.split('-').map(Number);
  const adultLimit = `${y - 18}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (input.birth_date > adultLimit) return bad('Il contratto lo firma una persona maggiorenne', 'birth_date');
  v.birth_date = input.birth_date;
  const e2 = text('residence', 5, 200);
  if (e2) return e2;
  const cf = String(input.tax_code ?? '').replace(/\s+/g, '').toUpperCase();
  if (cf) {
    if (!isCodiceFiscale(cf)) return bad('Codice fiscale non valido: controlla le lettere e i numeri (per gli stranieri si può lasciare vuoto)', 'tax_code');
    v.tax_code = cf;
  } else v.tax_code = '';
  const doc = cleanText(input.doc_number);
  if (doc === null || !/^[A-Za-z0-9][A-Za-z0-9 ./-]{2,29}$/.test(doc || '')) return bad('Numero del documento non valido', 'doc_number');
  v.doc_number = doc.toUpperCase();
  return { ok: true, value: v };
}

/* ------------------------------ Testo del contratto ------------------------------ */

const BLANK = '____________';

/** Grassetto nel testo del contratto: **testo** (come nel contratto Word di Mattia). */
export const bold = (s) => `**${s}**`;
/** Toglie i segni del grassetto (testo semplice). */
export const plain = (s) => String(s ?? '').replace(/\*\*/g, '');

function gender(sal, m, f) { return sal === 'F' ? f : m; }

/** Riga del conduttore (si mostra anche mentre l'ospite scrive i suoi dati). */
export function guestParagraph(g = {}, lang = 'it') {
  if (lang === 'en') return guestParagraphEn(g);
  const val = (s) => (s ? s : BLANK);
  const sal = g.sal === 'F' ? 'La Sig.ra' : 'Il Sig.';
  const cf = g.tax_code ? `, C.F. ${String(g.tax_code).toUpperCase()}` : '';
  return `${sal} ${val(g.name)}, ${gender(g.sal, 'nato', 'nata')} a ${val(g.birth_place)} il ${g.birth_date ? formatItDate(g.birth_date) : BLANK}, `
    + `residente in ${val(g.residence)}${cf}, documento di identità n. ${val(String(g.doc_number || '').toUpperCase())}, di seguito ${bold('“Conduttore”')};`;
}

function landlordParagraph(info) {
  const role = ROLES[info.landlord_role] ? ROLES[info.landlord_role][info.landlord_sal === 'F' ? 1 : 0] : BLANK;
  return `${info.landlord_sal === 'F' ? 'La Sig.ra' : 'Il Sig.'} ${bold(info.landlord_name || BLANK)}, ${gender(info.landlord_sal, 'nato', 'nata')} a ${bold(info.landlord_birth_place || BLANK)} `
    + `il ${bold(info.landlord_birth_date ? formatItDate(info.landlord_birth_date) : BLANK)}, residente in ${bold(info.landlord_residence || BLANK)}, `
    + `in qualità di ${bold(role)} dell’immobile, di seguito ${bold('“Locatore”')};`;
}

/** Data e ora italiane di un istante ISO: { date: '13/11/2026', time: '15:42' }. */
export function romeDateTime(iso) {
  const d = new Date(iso);
  return { date: formatItDate(todayRome(d)), time: timeRome(d) };
}

/** Data di cancellazione automatica: KEEP_YEARS anni dopo la partenza. */
export function purgeDate(checkOut) {
  const [y, m, d] = checkOut.split('-').map(Number);
  const target = `${y + KEEP_YEARS}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(target) ? target : addDays(`${y + KEEP_YEARS}-${String(m).padStart(2, '0')}-28`, 1);
}

/**
 * Informativa privacy breve, mostrata prima della firma e aggiunta in fondo al PDF.
 */
export function privacyNotice(info) {
  const owner = info.landlord_name || 'il Locatore';
  return [
    `Titolare del trattamento: ${owner}${info.privacy_contact ? ` (contatto: ${info.privacy_contact})` : ''}.`,
    'Dati trattati: nome e cognome, luogo e data di nascita, residenza, codice fiscale (se presente), numero del documento di identità, firma e dati della prenotazione.',
    'Finalità e base giuridica: stipula ed esecuzione del contratto di locazione (art. 6, par. 1, lett. b, GDPR) e adempimento degli obblighi di legge (art. 6, par. 1, lett. c, GDPR). Senza questi dati il contratto non si può stipulare.',
    `Conservazione: il contratto firmato è conservato in forma elettronica, in un archivio protetto ad accesso riservato, per ${KEEP_YEARS} anni dalla fine del soggiorno e poi cancellato, salvo che la legge imponga una conservazione più lunga o che serva per tutelare un diritto in giudizio.`,
    'Comunicazione: i dati non sono diffusi né ceduti a terzi; possono essere comunicati alle Autorità quando la legge lo richiede e sono custoditi dai fornitori dei servizi informatici che ospitano l’archivio, con dati conservati nell’Unione europea.',
    'Diritti: l’interessato può chiedere al Titolare l’accesso ai propri dati, la rettifica, la cancellazione o la limitazione del trattamento, nei limiti previsti dalla legge, e può presentare reclamo al Garante per la protezione dei dati personali (www.garanteprivacy.it).',
  ];
}

/**
 * Testo del contratto, come elenco di blocchi:
 *   { t: 'title' | 'center' | 'h' | 'p' | 'li' | 'guest' | 'place' | 'privacy-h' | 'privacy', text }
 *   più { t: 'sign', host, guest }: nomi sotto le firme.
 * Con guest = null il blocco del conduttore resta { t: 'guest' } (l'app lo riempie mentre si scrive).
 * Con signedAt = null data della firma in bianco.
 */
export function buildContract({ house, info, booking: b, guest = null, signedAt = null, lang = 'it' }) {
  if (lang === 'en') return buildContractEn({ house, info, booking: b, guest, signedAt, keepYears: KEEP_YEARS });
  const out = [];
  const add = (t, text) => out.push(text === undefined ? { t } : { t, text });
  let n = 0;
  const art = (title) => add('h', `Art. ${++n} – ${title}`);
  const city = info.city || 'Gallipoli';

  add('title', 'CONTRATTO DI LOCAZIONE AD USO TURISTICO – LOCAZIONE BREVE');
  add('center', 'TRA');
  add('p', landlordParagraph(info));
  add('center', 'E');
  if (guest) add('p', guestParagraph(guest)); else add('guest');
  add('p', 'congiuntamente anche “le Parti”,');
  add('center', 'SI CONVIENE E SI STIPULA QUANTO SEGUE.');

  art('Oggetto della locazione');
  add('p', `Il Locatore concede in locazione al Conduttore, che accetta, l’unità immobiliare sita in ${bold(`${city}, ${info.address || BLANK}`)}, ${info.description || BLANK}, completamente arredata e corredata.`);
  add('p', 'L’immobile viene concesso esclusivamente per finalità turistiche, ai sensi della normativa vigente.');
  add('p', bold(`Codice Identificativo Nazionale (CIN): ${info.cin || BLANK}`));
  add('p', 'Il Conduttore dichiara di aver ricevuto informazioni sulle caratteristiche dell’immobile e di accettarne lo stato di manutenzione, gli arredi e le dotazioni presenti, fatto salvo quanto eventualmente segnalato al momento dell’ingresso.');

  art('Durata');
  add('p', 'La locazione avrà durata determinata:');
  add('li', `${bold(`dal giorno ${formatItDate(b.check_in)}`)} (check-in dalle ore ${house.checkin_time});`);
  add('li', `${bold(`al giorno ${formatItDate(b.check_out)}`)} (check-out entro le ore ${house.checkout_time}).`);
  add('p', 'Alla scadenza il contratto cesserà automaticamente, senza necessità di disdetta. Il Conduttore si impegna a riconsegnare l’immobile libero da persone e cose entro l’orario stabilito.');
  add('p', 'In caso di ritardo non preventivamente autorizzato, il Locatore si riserva il diritto di richiedere il risarcimento degli eventuali danni e delle maggiori spese documentabili derivanti dal ritardo, fatto salvo ogni ulteriore diritto previsto dalla legge.');

  art('Numero degli ospiti');
  add('p', 'L’immobile potrà essere occupato esclusivamente dalle persone indicate nella prenotazione e identificate secondo le disposizioni di legge.');
  add('p', bold(`Numero degli occupanti indicati nella prenotazione: ${b.guests} ${b.guests === 1 ? 'persona' : 'persone'}.`));
  add('p', 'È vietato consentire il pernottamento o l’utilizzo dell’immobile da parte di persone ulteriori rispetto a quelle indicate nella prenotazione, senza la preventiva autorizzazione scritta del Locatore.');
  add('p', 'L’eventuale violazione costituisce grave inadempimento contrattuale e potrà comportare la risoluzione del contratto nei casi e secondo le modalità previste dalla legge, fatto salvo il diritto al risarcimento degli eventuali danni.');

  art('Obblighi del Conduttore');
  add('p', 'Il Conduttore si impegna a:');
  [
    'utilizzare l’immobile esclusivamente per finalità turistiche;',
    'custodire con diligenza l’immobile, gli arredi e tutte le dotazioni;',
    `${bold('restituire l’immobile nello stesso stato in cui lo ha ricevuto, salvo il normale deterioramento dovuto all’uso')};`,
    'comunicare tempestivamente eventuali guasti, anomalie o danni;',
    'rispettare il regolamento condominiale e le norme di civile convivenza;',
    info.quiet_hours ? `${bold(`rispettare gli orari di silenzio, indicativamente ${info.quiet_hours}`)};` : null,
    'spegnere luci, climatizzatori e apparecchi elettrici quando non necessari e prima di lasciare l’immobile;',
    'lasciare la cucina in ordine, provvedendo al lavaggio delle stoviglie, delle pentole e degli utensili utilizzati durante il soggiorno;',
    `${bold(`provvedere allo smaltimento dei rifiuti, conferendoli negli appositi contenitori secondo le modalità e il calendario della raccolta differenziata previsti dal Comune di ${city}`)}, evitando di lasciare sacchetti di spazzatura all’interno dell’immobile al momento della partenza.`,
  ].filter(Boolean).forEach((x) => add('li', x));
  add('p', 'È vietato:');
  [
    'sublocare o concedere a terzi l’immobile;',
    'organizzare feste, eventi o riunioni;',
    'arrecare disturbo al vicinato;',
    'utilizzare l’immobile per attività illecite;',
    'modificare impianti, arredi o dotazioni dell’immobile;',
    'fumare all’interno dell’immobile.',
  ].forEach((x) => add('li', x));
  add('p', 'È consentito fumare esclusivamente negli spazi esterni eventualmente presenti, avendo cura di non arrecare disturbo e di non disperdere mozziconi.');
  if (info.extra_rules) {
    add('p', 'Regole particolari della casa:');
    for (const line of info.extra_rules.split('\n')) if (line.trim()) add('li', line.trim().replace(/^[-–•]\s*/, ''));
  }

  art('Presenza e responsabilità dei minori');
  add('p', 'I minori presenti nell’immobile devono essere accompagnati e costantemente vigilati da almeno un adulto che ne eserciti la responsabilità genitoriale o che ne abbia legittimamente la custodia durante l’intero soggiorno.');
  add('p', 'Il Conduttore e gli altri ospiti maggiorenni accompagnatori sono responsabili della vigilanza, della custodia e del comportamento dei minori presenti nell’immobile e nelle eventuali pertinenze, rispondendo degli eventuali danni arrecati all’immobile, agli arredi, alle dotazioni o a terzi, nei limiti previsti dalla legge.');
  add('p', 'Il Locatore non assume obblighi di sorveglianza nei confronti dei minori presenti nell’immobile, fermo restando il rispetto degli obblighi di legge relativi alla sicurezza dell’immobile.');

  art('Check-in, identificazione degli ospiti e comunicazioni obbligatorie');
  add('p', 'Prima dell’ingresso nell’immobile, il Conduttore dovrà consentire l’identificazione propria e di tutti gli occupanti, compresi i minori, mediante documenti di identità validi e secondo le modalità consentite dalla normativa vigente. Tale adempimento è necessario per consentire al Locatore di effettuare le comunicazioni obbligatorie delle generalità degli ospiti alle Autorità competenti, tramite il portale Alloggiati Web.');
  add('p', 'Il mancato completamento delle procedure di identificazione potrà impedire la consegna dell’immobile, nel rispetto delle disposizioni di legge.');
  add('p', 'I dati personali e gli estremi dei documenti saranno trattati esclusivamente per gli adempimenti previsti dalla normativa vigente e per le finalità connesse alla gestione del soggiorno. Le eventuali copie dei documenti acquisite per consentire l’inserimento dei dati nel portale Alloggiati Web saranno cancellate o distrutte dopo il completamento dell’adempimento e il rilascio della relativa ricevuta, salvo diversi obblighi di legge.');

  art('Corrispettivo della locazione');
  add('p', 'Il corrispettivo della locazione è quello concordato tra le Parti prima della conclusione della prenotazione e risultante dalla relativa conferma scritta (anche inviata tramite messaggio), dalla ricevuta di pagamento o da altro documento idoneo a comprovarne l’importo e le modalità di pagamento.');

  art('Acconto, saldo e cancellazione');
  add('p', `Al momento della prenotazione il Conduttore versa un acconto${info.advance_pct ? ` pari a circa il ${info.advance_pct}% del corrispettivo` : ''}, nella misura indicata nella conferma scritta. Il saldo è dovuto all’arrivo, salvo diverso accordo scritto tra le Parti.`);
  add('p', `In caso di cancellazione da parte del Conduttore, in qualunque momento, o di mancato arrivo, ${bold('l’acconto versato resta acquisito dal Locatore e non è rimborsabile')}.`);
  add('p', 'In caso di arrivo posticipato o di partenza anticipata rispetto alle date concordate, il corrispettivo resta dovuto per intero.');
  add('p', 'Se la locazione non può avere luogo per causa imputabile al Locatore, l’acconto versato è restituito integralmente al Conduttore, fatto salvo quanto previsto dalla legge.');

  art('Spese e consumi');
  add('p', 'Nel corrispettivo della locazione sono compresi:');
  add('li', 'consumi di acqua;');
  add('li', 'pulizia finale;');
  const notIncluded = [];
  if (b.linens && b.towels) add('li', 'fornitura iniziale di biancheria da letto e da bagno (lenzuola e asciugamani).');
  else if (b.linens) { add('li', 'fornitura iniziale di biancheria da letto.'); notIncluded.push('gli asciugamani'); }
  else if (b.towels) { add('li', 'fornitura iniziale di asciugamani.'); notIncluded.push('la biancheria da letto'); }
  else notIncluded.push('la biancheria da letto e gli asciugamani');
  if (notIncluded.length) add('p', `Non sono compresi ${notIncluded.join(' e ')}.`);
  if (info.kwh_day) {
    add('p', `Sono inoltre compresi i consumi di energia elettrica fino a ${bold(`${info.kwh_day} kWh per ogni giorno di soggiorno`)}. Gli eventuali consumi eccedenti tale soglia saranno addebitati al costo di ${bold(`${fmtEuro(info.kwh_price_cents)} per ogni kWh eccedente`)}.`);
    add('p', 'La lettura del contatore sarà effettuata all’arrivo e alla partenza mediante rilevazione diretta o documentazione fotografica. L’eventuale eccedenza sarà calcolata moltiplicando i kWh eccedenti la soglia complessiva prevista per la durata del soggiorno per il costo unitario sopra indicato; il relativo importo sarà comunicato al Conduttore e dovrà essere corrisposto al termine del soggiorno, previa documentazione delle letture effettuate.');
  } else {
    add('p', 'Sono inoltre compresi i consumi di energia elettrica, nei limiti di un uso normale.');
  }
  add('p', `${bold('La tassa di soggiorno non è compresa nel corrispettivo')} ed è dovuta a parte, secondo le tariffe e le esenzioni stabilite dal Comune di ${city}.`);

  art('Deposito cauzionale');
  if (b.security_cents > 0) {
    add('p', `Il Conduttore versa a titolo di deposito cauzionale la somma di ${bold(fmtEuro(b.security_cents))}, a garanzia dell’esatto adempimento delle obbligazioni contrattuali.`);
    add('p', 'La cauzione sarà restituita al termine del soggiorno, previa verifica dello stato dei locali e delle dotazioni e del rispetto degli obblighi contrattuali.');
    add('p', 'Il Locatore potrà trattenere totalmente o parzialmente la cauzione esclusivamente per compensare eventuali danni, consumi eccedenti o spese documentabili imputabili al Conduttore, comunicandone le relative motivazioni. **Qualora il danno o le somme dovute siano superiori all’importo della cauzione, il Conduttore sarà tenuto a corrispondere la differenza.**');
    add('p', 'La cauzione non costituisce penale e non comporta la perdita automatica dell’intero importo in caso di inadempimenti.');
  } else {
    add('p', 'Per il presente soggiorno non è previsto il versamento di un deposito cauzionale. Resta ferma la responsabilità del Conduttore per eventuali danni, consumi eccedenti o spese documentabili a lui imputabili, secondo quanto previsto dal presente contratto.');
  }

  art('Danni e anomalie');
  add('p', 'Il Conduttore risponde dei danni arrecati all’immobile, agli arredi, agli elettrodomestici, agli impianti e alle parti comuni durante il soggiorno, salvo il normale deterioramento dovuto all’uso.');
  add('p', 'Eventuali anomalie, guasti o danni già presenti all’arrivo dovranno essere comunicati al Locatore **entro il giorno del check-in**, preferibilmente **mediante documentazione fotografica**. Il Conduttore dovrà comunicare tempestivamente eventuali danni verificatisi durante il soggiorno, evitando, ove possibile, che possano aggravarsi.');

  art('Accesso all’immobile');
  add('p', 'Il Locatore, direttamente o tramite un proprio incaricato, potrà accedere all’immobile, previo ragionevole preavviso e accordo con il Conduttore, per verificare eventuali problematiche, effettuare interventi di manutenzione necessari o urgenti e accertare lo stato dell’immobile.');
  add('p', 'In caso di emergenza o pericolo imminente per persone o cose, l’accesso potrà avvenire senza preavviso, nei limiti consentiti dalla legge.');

  art('Oggetti personali dimenticati');
  add('p', 'Il Conduttore è tenuto a verificare, prima della partenza, di non aver dimenticato oggetti personali all’interno dell’immobile. Il Locatore non risponde degli oggetti personali dimenticati, salvo i casi di responsabilità previsti dalla legge.');

  art('Forza maggiore');
  add('p', 'Nessuna delle Parti sarà responsabile per l’inadempimento dovuto a cause di forza maggiore, quali calamità naturali, provvedimenti dell’Autorità o altri eventi imprevedibili e inevitabili, nei limiti e secondo le disposizioni di legge.');

  art('Trattamento dei dati personali');
  add('p', 'Le Parti dichiarano di essere informate che i dati personali saranno trattati esclusivamente per l’esecuzione del presente contratto e per gli adempimenti previsti dalla legge, nel rispetto del Regolamento (UE) 2016/679 (GDPR) e della normativa italiana vigente. Il Conduttore dichiara di aver ricevuto e letto l’informativa sul trattamento dei propri dati personali, riportata in calce al presente contratto.');

  art('Sottoscrizione elettronica');
  add('p', 'Il presente contratto è sottoscritto dalle Parti mediante firma grafica apposta su dispositivo elettronico, che costituisce firma elettronica ai sensi del Regolamento (UE) n. 910/2014 e del D.Lgs. 82/2005. Al documento sono associate la data e l’ora della sottoscrizione e un’impronta informatica (SHA-256) che ne garantisce l’integrità. Una copia del contratto in formato PDF è consegnata al Conduttore.');

  art('Rinvio normativo');
  add('p', 'Per quanto non espressamente previsto dal presente contratto si applicano le disposizioni del Codice Civile, della normativa italiana in materia di locazioni ad uso turistico e delle altre disposizioni vigenti.');

  art('Accettazione');
  add('p', 'Il Conduttore dichiara di aver ricevuto informazioni sufficienti sulle caratteristiche dell’immobile, di averne preso visione attraverso la descrizione e il materiale fotografico fornito e di accettarne lo stato di manutenzione, gli arredi e tutte le condizioni del presente contratto, fatto salvo il normale deterioramento dovuto all’uso e quanto eventualmente segnalato al check-in.');

  add('place', `${city}, lì ${signedAt ? romeDateTime(signedAt).date : '____ / ____ / ______'}`);
  out.push({ t: 'sign', host: info.landlord_name || '', guest: guest ? guest.name : '' });

  add('privacy-h', 'Informativa sul trattamento dei dati personali (art. 13 del Regolamento UE 2016/679)');
  for (const p of privacyNotice(info)) add('privacy', p);
  return out;
}

/** Testo semplice del contratto (per l'impronta e i controlli). */
export function contractText(blocks) {
  return blocks.map((x) => plain(x.t === 'li' ? `- ${x.text}` : x.t === 'sign' ? `Firme: ${x.host} / ${x.guest}` : x.text ?? '')).join('\n');
}

/**
 * Testo su cui si calcola l'impronta SHA-256: sempre uguale per gli stessi dati, in quest'ordine.
 */
export function hashInput(c) {
  const base = [c.template, c.id, c.booking_id, c.house_id, c.body, c.guest, c.guest_sign, c.host_sign, c.signed_at];
  // La lingua entra nell'impronta solo se non è l'italiano (così le impronte dei primi contratti restano valide).
  return JSON.stringify(c.lang && c.lang !== 'it' ? [...base, c.lang] : base);
}

/** Impronta SHA-256 in esadecimale (funziona nel browser, in Node e nei Worker). */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------- Firme ------------------------------- */

/** Decodifica base64 in byte (senza dipendere da Buffer o atob). */
export function base64ToBytes(b64) {
  const map = new Int16Array(128).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) map[chars.charCodeAt(i)] = i;
  const clean = b64.replace(/=+$/, '');
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (i + k < clean.length ? map[clean.charCodeAt(i + k)] : 0));
    if (v.some((x) => x < 0)) return null;
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/**
 * Legge le dimensioni di un JPEG (marcatori SOF). Restituisce { width, height, components, progressive }
 * oppure null se non è un JPEG valido.
 */
export function jpegInfo(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xFF) return null;
    const marker = bytes[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    if (marker === 0xFF) { i += 1; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return null;
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
        progressive: marker === 0xC2,
      };
    }
    if (marker === 0xDA || marker === 0xD9) return null;
    i += 2 + len;
  }
  return null;
}

/** Controllo di una firma: data URL JPEG, dimensioni ragionevoli. Restituisce { ok, bytes, info } o { ok: false, error }. */
export function checkSignature(dataUrl) {
  const prefix = 'data:image/jpeg;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) return { ok: false, error: 'Firma mancante' };
  if (dataUrl.length > prefix.length + Math.ceil((MAX_SIGN_BYTES * 4) / 3) + 4) return { ok: false, error: 'Firma troppo grande' };
  const bytes = base64ToBytes(dataUrl.slice(prefix.length));
  if (!bytes || bytes.length < 200) return { ok: false, error: 'Firma non valida' };
  const info = jpegInfo(bytes);
  if (!info || info.width < 100 || info.width > 2000 || info.height < 40 || info.height > 1000 || ![1, 3].includes(info.components)) {
    return { ok: false, error: 'Firma non valida' };
  }
  if (bytes[bytes.length - 2] !== 0xFF || bytes[bytes.length - 1] !== 0xD9) return { ok: false, error: 'Firma non valida' };
  return { ok: true, bytes, info };
}
