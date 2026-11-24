// Modulo online per gli ospiti: logica del server (usata dal Worker pubblico ospiti/ e, per il link, dal gestionale).
//
// Sicurezza:
//  * il link contiene un codice casuale di 12 caratteri (alfabeto di 58 simboli, circa 70 bit): non si indovina,
//    tanto più che vale pochi giorni; senza caratteri che si confondono (0/O, l/I);
//  * il modulo può solo SCRIVERE i dati degli ospiti: non restituisce mai dati già salvati (né nomi, né documenti);
//  * funziona solo per prenotazioni attive, finché le schedine non sono inviate e al massimo fino al giorno dopo l'arrivo;
//  * più persone possono compilarlo, ognuna dal suo telefono: ogni telefono ha un codice suo ("parte"), i suoi invii
//    si sommano a quelli degli altri e un nuovo invio dallo stesso telefono sostituisce solo i suoi dati;
//  * chi ha prenotato (con il documento) è uno solo; al massimo 40 invii per link;
//  * gli stessi controlli dei dati inseriti nel gestionale (cleanGuest) e in più tutti i campi obbligatori.

import { OpError, REV_NEXT, commit, registerOps } from './ops.js';
import { cleanGuest, refreshComplete } from './guests.js';
import { searchPlaces, docTypes } from './questura.js';
import { MAX_GUESTS, guestMissing } from '../public/shared/alloggiati.js';
import { addDays, todayRome } from '../public/shared/dates.js';

export const TOKEN_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const TOKEN_RE = /^[1-9A-HJ-NP-Za-km-z]{12}$/;
const MAX_SUBMITS = 40;
export const PART_RE = /^[A-Za-z0-9_-]{16,64}$/;
const FORM_USER = { id: 'modulo-ospiti', email: 'modulo-ospiti@digihome.invalid', name: 'Modulo online (ospite)', role: 'ospite' };
const bad = (m) => new OpError(400, 'validation', m);

/** Codice del link: 12 caratteri casuali (scarto dei byte oltre 232, così ogni simbolo è ugualmente probabile). */
export function newFormToken() {
  let out = '';
  while (out.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 232 && out.length < 12) out += TOKEN_ALPHABET[b % 58];
    }
  }
  return out;
}

/** Ultimo giorno in cui il link funziona (il giorno dopo l'arrivo). */
export function formLastDay(b) {
  return addDays(b.check_in, 1);
}

/** Perché il modulo non è (più) disponibile, oppure null se lo è. */
export function formClosedReason(b, today = todayRome()) {
  if (!b) return 'not_found';
  if (b.stage === 'cancellata') return 'cancelled';
  if (b.alloggiati_at) return 'done';
  if (today > formLastDay(b)) return 'expired';
  if ((b.guest_form_submits || 0) >= MAX_SUBMITS) return 'too_many';
  return null;
}

async function bookingByToken(db, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  return db.prepare('SELECT * FROM bookings WHERE guest_form_token = ?').bind(token).first();
}

/** Informazioni minime per la pagina: casa, date, numero di ospiti. Nessun dato personale. */
export async function formInfo(db, token, today = todayRome(), part = null) {
  const b = await bookingByToken(db, token);
  const reason = formClosedReason(b, today);
  if (reason === 'not_found') throw new OpError(404, 'not_found', 'Link non valido.');
  const house = await db.prepare('SELECT name, color, contract_info FROM houses WHERE id = ?').bind(b.house_id).first();
  const color = /^#[0-9A-Fa-f]{6}$/.test(house.color || '') ? house.color : null;
  // Link chiuso (schedine inviate, scaduto, cancellato): solo il motivo, niente date, persone o locatore.
  // Chi ritrova il link in una chat dopo mesi non scopre più quando e dove era il soggiorno.
  if (reason) return { open: false, reason, house: house.name, color };
  // Titolare e contatto per l'informativa: dai Dati del contratto della casa.
  let controller = null;
  let privacyContact = null;
  try {
    const ci = JSON.parse(house.contract_info || '{}');
    controller = ci.landlord_name || null;
    privacyContact = ci.privacy_contact || null;
  } catch { controller = null; }
  return {
    open: !reason,
    reason,
    house: house.name,
    color,
    controller,
    privacy_contact: privacyContact,
    check_in: b.check_in,
    check_out: b.check_out,
    guests: b.guests,
    submitted: Boolean(b.guest_form_at),
    // Solo numeri: quanti ospiti sono già stati inseriti (da tutti) e quanti da questo telefono. Mai i nomi.
    entered: reason ? 0 : (await db.prepare('SELECT COUNT(*) AS n FROM guests WHERE booking_id = ? AND deleted = 0').bind(b.id).first()).n,
    mine: reason || !PART_RE.test(String(part || '')) ? 0
      : (await db.prepare('SELECT COUNT(*) AS n FROM guests WHERE booking_id = ? AND deleted = 0 AND form_part = ?').bind(b.id, part).first()).n,
    leaderTaken: Boolean(b.guest_form_leader_part) && b.guest_form_leader_part !== part,
    iAmLeader: Boolean(b.guest_form_leader_part) && b.guest_form_leader_part === part,
    last_day: formLastDay(b),
    docTypes: reason ? [] : await docTypes(db),
  };
}

/**
 * Nomi degli stati in inglese (e qualche forma comune) → nome italiano delle tabelle ufficiali,
 * così un ospite straniero trova "Germany" scrivendo in inglese.
 */
const COUNTRY_ALIASES = {
  ITALY: 'ITALIA', GERMANY: 'GERMANIA', DEUTSCHLAND: 'GERMANIA', FRANCE: 'FRANCIA', SPAIN: 'SPAGNA', ESPANA: 'SPAGNA',
  'UNITED KINGDOM': 'REGNO UNITO', UK: 'REGNO UNITO', ENGLAND: 'REGNO UNITO', 'GREAT BRITAIN': 'REGNO UNITO', SCOTLAND: 'REGNO UNITO', WALES: 'REGNO UNITO',
  NETHERLANDS: 'PAESI BASSI', HOLLAND: 'PAESI BASSI', NEDERLAND: 'PAESI BASSI', SWITZERLAND: 'SVIZZERA', SCHWEIZ: 'SVIZZERA', SUISSE: 'SVIZZERA',
  BELGIUM: 'BELGIO', BELGIQUE: 'BELGIO', AUSTRIA: 'AUSTRIA', OSTERREICH: 'AUSTRIA', 'UNITED STATES': 'STATI UNITI', USA: 'STATI UNITI', AMERICA: 'STATI UNITI',
  POLAND: 'POLONIA', POLSKA: 'POLONIA', SWEDEN: 'SVEZIA', SVERIGE: 'SVEZIA', NORWAY: 'NORVEGIA', NORGE: 'NORVEGIA', DENMARK: 'DANIMARCA', DANMARK: 'DANIMARCA',
  FINLAND: 'FINLANDIA', IRELAND: 'IRLANDA', PORTUGAL: 'PORTOGALLO', GREECE: 'GRECIA', 'CZECH REPUBLIC': 'CECA', CZECHIA: 'CECA', HUNGARY: 'UNGHERIA',
  CROATIA: 'CROAZIA', HRVATSKA: 'CROAZIA', SLOVENIA: 'SLOVENIA', SLOVAKIA: 'SLOVACCHIA', ROMANIA: 'ROMANIA', BULGARIA: 'BULGARIA', SERBIA: 'SERBIA',
  ALBANIA: 'ALBANIA', LUXEMBOURG: 'LUSSEMBURGO', MALTA: 'MALTA', CANADA: 'CANADA', AUSTRALIA: 'AUSTRALIA', 'NEW ZEALAND': 'NUOVA ZELANDA',
  BRAZIL: 'BRASILE', BRASIL: 'BRASILE', ARGENTINA: 'ARGENTINA', MEXICO: 'MESSICO', JAPAN: 'GIAPPONE', CHINA: 'CINA', INDIA: 'INDIA',
  RUSSIA: 'RUSSA', UKRAINE: 'UCRAINA', TURKEY: 'TURCHIA', TURKIYE: 'TURCHIA', ISRAEL: 'ISRAELE', MOROCCO: 'MAROCCO', TUNISIA: 'TUNISIA', EGYPT: 'EGITTO',
  'SOUTH AFRICA': 'SUD AFRICA', LITHUANIA: 'LITUANIA', LATVIA: 'LETTONIA', ESTONIA: 'ESTONIA', ICELAND: 'ISLANDA', CYPRUS: 'CIPRO', MONACO: 'MONACO',
  'SAN MARINO': 'SAN MARINO', 'VATICAN CITY': 'VATICANO', MOLDOVA: 'MOLDOVA', 'NORTH MACEDONIA': 'MACEDONIA', 'BOSNIA AND HERZEGOVINA': 'BOSNIA',
  MONTENEGRO: 'MONTENEGRO', KOSOVO: 'KOSOVO', 'SOUTH KOREA': 'COREA', KOREA: 'COREA',
};

export function countryAlias(q) {
  const t = String(q || '').trim().toUpperCase();
  if (t.length < 2) return null;
  const hit = Object.keys(COUNTRY_ALIASES).find((k) => k.startsWith(t));
  return hit ? COUNTRY_ALIASES[hit] : null;
}

export async function formPlaces(db, token, q, kind, today = todayRome()) {
  const b = await bookingByToken(db, token);
  if (formClosedReason(b, today)) throw new OpError(404, 'not_found', 'Link non valido.');
  const list = await searchPlaces(db, q, kind);
  const alias = kind !== 'C' ? countryAlias(q) : null;
  if (!alias) return list;
  const extra = await searchPlaces(db, alias, 'S');
  const seen = new Set(list.map((x) => x.code));
  return [...extra.filter((x) => !seen.has(x.code)), ...list].slice(0, 15);
}

/**
 * Invio dei dati da parte di un ospite (da un telefono = una "parte").
 * leader: true se chi compila è chi ha prenotato (il primo ospite dell'invio porta il documento).
 * I dati di questa parte sostituiscono i suoi invii precedenti; quelli degli altri telefoni restano.
 * Tutti i campi sono obbligatori: così all'arrivo basta un controllo.
 */
export async function submitForm(db, token, body, today = todayRome()) {
  const b = await bookingByToken(db, token);
  const reason = formClosedReason(b, today);
  if (reason === 'not_found') throw new OpError(404, 'not_found', 'Link non valido.');
  if (reason) throw new OpError(409, reason, 'Il modulo non è più disponibile.');
  if (!body || typeof body !== 'object' || !Array.isArray(body.guests)) throw bad('Richiesta non valida');
  const part = String(body.part || '');
  if (!PART_RE.test(part)) throw bad('Richiesta non valida');
  const leader = body.leader === true;
  if (leader && b.guest_form_leader_part && b.guest_form_leader_part !== part) {
    throw new OpError(409, 'leader_taken', 'Chi ha prenotato ha già inserito i suoi dati da un altro telefono: inserisci i tuoi come altro ospite.');
  }
  const list = body.guests;
  const others = (await db.prepare('SELECT COUNT(*) AS n FROM guests WHERE booking_id = ? AND deleted = 0 AND (form_part IS NULL OR form_part <> ?)')
    .bind(b.id, part).first()).n;
  const max = Math.min(MAX_GUESTS, b.guests + 4);
  if (list.length < 1 || list.length > MAX_GUESTS) throw bad('Numero di ospiti non valido');
  if (others + list.length > max) throw bad(`Sono già stati inseriti ${others} ospiti su ${b.guests}: controlla di non averli inseriti due volte.`);
  const group = body.group === 'gruppo' ? 'gruppo' : 'famiglia';
  const clean = [];
  const codes = new Set();
  for (let i = 0; i < list.length; i++) {
    let g;
    try {
      g = cleanGuest(list[i]);
    } catch (e) {
      throw new OpError(400, 'validation', `Ospite ${i + 1}: ${e.message}`, { index: i });
    }
    const withDoc = leader && i === 0;
    if (!withDoc) { g.doc_type = null; g.doc_number = null; g.doc_place = null; }
    const miss = guestMissing(g, withDoc, { today });
    if (miss.length) throw new OpError(400, 'validation', `Ospite ${i + 1}: manca ${miss.join(', ')}`, { index: i, missing: miss });
    for (const k of ['birth_place', 'citizenship', 'residence', 'doc_place']) if (g[k]) codes.add(g[k]);
    clean.push(g);
  }
  // I luoghi devono esistere nelle tabelle ufficiali (e la cittadinanza deve essere uno stato).
  const found = new Map(((await db.prepare(`SELECT code, kind FROM places WHERE code IN (${[...codes].map(() => '?').join(', ')})`).bind(...codes).all()).results || [])
    .map((x) => [x.code, x.kind]));
  for (let i = 0; i < clean.length; i++) {
    const g = clean[i];
    for (const k of ['birth_place', 'citizenship', 'residence', 'doc_place']) {
      if (g[k] && !found.has(g[k])) throw new OpError(400, 'validation', `Ospite ${i + 1}: luogo non valido, sceglilo dall’elenco`, { index: i });
    }
    if (found.get(g.citizenship) !== 'S') throw new OpError(400, 'validation', `Ospite ${i + 1}: la cittadinanza deve essere uno stato`, { index: i });
  }
  if (leader && !(await db.prepare('SELECT 1 FROM doc_types WHERE code = ?').bind(clean[0].doc_type).first())) {
    throw new OpError(400, 'validation', 'Ospite 1: tipo di documento non valido', { index: 0 });
  }

  const at = new Date().toISOString();
  // Chi corregge i suoi dati mantiene il suo posto nell'elenco: conta il momento del suo primo invio.
  const first = await db.prepare('SELECT MIN(created_at) AS t FROM guests WHERE booking_id = ? AND form_part = ?').bind(b.id, part).first();
  const since = (first && first.t) || at;
  const FIELDS = ['last_name', 'first_name', 'sex', 'birth_date', 'birth_place', 'citizenship', 'residence', 'doc_type', 'doc_number', 'doc_place'];
  // Istruzione principale: conteggio degli invii (con il limite) e chi ha prenotato. Se nel frattempo un altro
  // telefono si è segnato come chi ha prenotato, l'invio non passa.
  const main = db.prepare(`UPDATE bookings SET guest_form_at = ?, guest_form_submits = guest_form_submits + 1,
      guest_group = CASE WHEN ? = 1 THEN ? ELSE guest_group END,
      guest_form_leader_part = CASE WHEN ? = 1 THEN ? WHEN guest_form_leader_part = ? THEN NULL ELSE guest_form_leader_part END,
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND guest_form_token = ? AND alloggiati_at IS NULL AND stage <> 'cancellata' AND guest_form_submits < ?
      AND (? = 0 OR guest_form_leader_part IS NULL OR guest_form_leader_part = ?)`)
    .bind(at, leader ? 1 : 0, group, leader ? 1 : 0, part, part, at, FORM_USER.email, b.id, token, MAX_SUBMITS, leader ? 1 : 0, part);
  // Le istruzioni collegate controllano da sole il segno della principale (vedi commit).
  const marked = `EXISTS (SELECT 1 FROM bookings WHERE id = ? AND rev = (SELECT value FROM meta WHERE key = 'rev') + 1)`;
  const also = [
    // I dati che questo telefono aveva già inviato si cancellano davvero (niente copie dei vecchi dati personali).
    db.prepare(`DELETE FROM guests WHERE booking_id = ? AND form_part = ? AND ${marked}`).bind(b.id, part, b.id),
    ...clean.map((g, i) => db.prepare(`INSERT INTO guests (id, booking_id, position, code, ${FIELDS.join(', ')}, complete, source, form_part, created_at, created_by, rev)
      SELECT ?, ?, ?, (SELECT COALESCE(MAX(code), 100000) + 1 FROM guests), ${FIELDS.map(() => '?').join(', ')}, 0, 'ospite', ?, ?, ?, ${REV_NEXT}
      WHERE ${marked}`)
      .bind(crypto.randomUUID(), b.id, i, ...FIELDS.map((f) => g[f]), part, since, FORM_USER.email, b.id)),
  ];
  const done = await commit(db, { main, also, user: FORM_USER, opId: crypto.randomUUID(), entity: 'booking', entityId: b.id, action: 'dati_ospiti',
    changes: { modulo: `dati di ${clean.length} ospiti inviati da un ospite${leader ? ' (chi ha prenotato)' : ''}` } });
  if (!done) {
    const now = await db.prepare('SELECT guest_form_leader_part FROM bookings WHERE id = ?').bind(b.id).first();
    if (leader && now && now.guest_form_leader_part && now.guest_form_leader_part !== part) {
      throw new OpError(409, 'leader_taken', 'Chi ha prenotato ha già inserito i suoi dati da un altro telefono: inserisci i tuoi come altro ospite.');
    }
    throw new OpError(409, 'closed', 'Il modulo non è più disponibile.');
  }
  await reorder(db, b.id);
  await refreshComplete(db, b.id);
  return { ok: true, count: clean.length };
}

/**
 * Ordine degli ospiti: prima chi ha prenotato (e chi ha inserito con lui), poi quelli inseriti nel gestionale,
 * poi gli altri telefoni in ordine di invio.
 */
async function reorder(db, bookingId) {
  const b = await db.prepare('SELECT guest_form_leader_part FROM bookings WHERE id = ?').bind(bookingId).first();
  const rows = (await db.prepare('SELECT id, form_part, position, created_at FROM guests WHERE booking_id = ? AND deleted = 0').bind(bookingId).all()).results || [];
  const firstAt = new Map();
  for (const r of rows) if (r.form_part && (!firstAt.has(r.form_part) || r.created_at < firstAt.get(r.form_part))) firstAt.set(r.form_part, r.created_at);
  const rank = (r) => (r.form_part && r.form_part === b.guest_form_leader_part ? 0 : r.form_part ? 2 : 1);
  rows.sort((x, y) => rank(x) - rank(y)
    || String(firstAt.get(x.form_part) || '').localeCompare(String(firstAt.get(y.form_part) || ''))
    || String(x.form_part || '').localeCompare(String(y.form_part || ''))
    || x.position - y.position);
  // Prima posizioni provvisorie (per non scontrarsi), poi quelle definitive 0, 1, 2…
  await db.batch([
    ...rows.map((r, i) => db.prepare('UPDATE guests SET position = ? WHERE id = ?').bind(49 - i, r.id)),
    ...rows.map((r, i) => db.prepare('UPDATE guests SET position = ? WHERE id = ?').bind(i, r.id)),
  ]);
}

/* ------------------------------ Gestionale: crea o disattiva il link ------------------------------ */

async function guestLinkOp(db, user, opId, p) {
  if (typeof p.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(p.id)) throw new OpError(400, 'validation', 'Richiesta non valida');
  const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(p.id).first();
  if (!b) throw new OpError(404, 'not_found', 'Prenotazione non trovata.');
  const at = new Date().toISOString();
  let main;
  if (p.action === 'revoke') {
    // "Ho prenotato io" si libera se gli ospiti di quel telefono non ci sono più (es. eliminati dal gestore).
    main = db.prepare(`UPDATE bookings SET guest_form_token = NULL, guest_form_leader_part = CASE WHEN EXISTS (SELECT 1 FROM guests g WHERE g.booking_id = bookings.id AND g.deleted = 0
        AND g.form_part = bookings.guest_form_leader_part) THEN guest_form_leader_part ELSE NULL END, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ?`)
      .bind(at, user.email, b.id);
  } else {
    if (b.stage === 'cancellata') throw new OpError(409, 'state', 'La prenotazione è cancellata.');
    if (b.alloggiati_at) throw new OpError(409, 'state', 'Le schedine sono già state inviate.');
    if (todayRome() > formLastDay(b)) throw new OpError(409, 'state', 'L’arrivo è già passato.');
    if (b.guest_form_token && !p.renew) return { record: b };
    main = db.prepare(`UPDATE bookings SET guest_form_token = ?, guest_form_created_at = ?, guest_form_submits = 0,
      guest_form_leader_part = CASE WHEN EXISTS (SELECT 1 FROM guests g WHERE g.booking_id = bookings.id AND g.deleted = 0
        AND g.form_part = bookings.guest_form_leader_part) THEN guest_form_leader_part ELSE NULL END, version = version + 1, rev = ${REV_NEXT},
      updated_at = ?, updated_by = ? WHERE id = ?`).bind(newFormToken(), at, at, user.email, b.id);
  }
  await commit(db, { main, user, opId, entity: 'booking', entityId: b.id, action: p.action === 'revoke' ? 'link_ospiti_disattivato' : 'link_ospiti',
    changes: { link: p.action === 'revoke' ? 'disattivato' : 'creato' } });
  return { record: await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first() };
}

registerOps({ 'booking.guest_link': guestLinkOp });
