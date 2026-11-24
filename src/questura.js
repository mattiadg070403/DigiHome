// Alloggiati Web dal gestionale: credenziali cifrate, prova di collegamento, tabelle ufficiali,
// invio delle schedine, ricevute automatiche (conservate 5 anni) e cancellazioni automatiche.

import { OpError, REV_NEXT, commit } from './ops.js';
import { hasSecret, openJson, sealJson } from './secrets.js';
import { WsError, alloggiatiClient, esitoText, parseDocTypes, parsePlaces } from './alloggiati-ws.js';
import { listGuests } from './guests.js';
import { bookingSchedine, guestMissing, sendWindow } from '../public/shared/alloggiati.js';
import { addDays, isIsoDate, todayRome } from '../public/shared/dates.js';

export const SYSTEM = { id: 'sistema', email: 'sistema@digihome.invalid', name: 'DigiHome (automatico)', role: 'admin' };
const RECEIPT_YEARS = 5;
const TABLES_MAX_AGE_DAYS = 30;
const LOCK_MS = 2 * 60 * 1000;
const bad = (m) => new OpError(400, 'validation', m);
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);
const nowIso = () => new Date().toISOString();
const purposeFor = (houseId) => `alloggiati:${houseId}`;

function requireAdmin(user) {
  if (user.role !== 'admin') throw new OpError(403, 'forbidden', 'Solo l’amministratore può farlo.');
}

export function parseStatus(house) {
  try { return house && house.alloggiati_status ? JSON.parse(house.alloggiati_status) : {}; } catch { return {}; }
}

async function getHouse(db, id) {
  if (!isId(id)) throw bad('Casa non valida');
  const h = await db.prepare('SELECT * FROM houses WHERE id = ?').bind(id).first();
  if (!h) throw new OpError(404, 'not_found', 'Casa non trovata.');
  return h;
}

/** Aggiorna lo stato del collegamento (JSON senza credenziali) passando dal registro. */
async function setStatus(db, user, house, patch, action = 'alloggiati') {
  const cur = parseStatus(house);
  const next = { ...cur, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const main = db.prepare(`UPDATE houses SET alloggiati_status = ?, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ?`)
    .bind(JSON.stringify(next), nowIso(), user.email, house.id);
  const changes = Object.fromEntries(Object.keys(patch).filter((k) => k !== 'error' || patch.error).map((k) => [k, k === 'error' ? 'errore' : 'aggiornato']));
  await commit(db, { main, user, opId: crypto.randomUUID(), entity: 'house', entityId: house.id, action, changes });
  return next;
}

/** Credenziali in chiaro, solo in memoria, solo per la richiesta in corso. */
async function credentialsFor(db, env, houseId) {
  const row = await db.prepare('SELECT alloggiati FROM house_secrets WHERE house_id = ?').bind(houseId).first();
  if (!row || !row.alloggiati) throw new OpError(409, 'not_configured', 'Il collegamento con Alloggiati Web non è impostato per questa casa (Impostazioni → Case).');
  if (!hasSecret(env)) throw new OpError(409, 'missing_secret', 'Manca la chiave segreta in Cloudflare: segui le istruzioni in Impostazioni → Case → Alloggiati Web.');
  try {
    return await openJson(env, purposeFor(houseId), row.alloggiati);
  } catch {
    throw new OpError(409, 'secret_changed', 'Non riesco a leggere le credenziali salvate (la chiave segreta in Cloudflare è cambiata?). Inseriscile di nuovo.');
  }
}

function wsFail(e) {
  if (e instanceof OpError) return e;
  if (e instanceof WsError) return new OpError(502, `ws_${e.code}`, e.message);
  return e;
}

/* ------------------------------ Credenziali e prova ------------------------------ */

export async function saveCredentials(db, env, user, p, { fetchImpl } = {}) {
  requireAdmin(user);
  const house = await getHouse(db, p.houseId);
  if (p.remove) {
    await db.prepare('DELETE FROM house_secrets WHERE house_id = ?').bind(house.id).run();
    const status = await setStatus(db, user, house, { configured: false, user_hint: undefined, ok_at: undefined, error: undefined, set_at: undefined }, 'alloggiati_rimosso');
    return { status };
  }
  if (!hasSecret(env)) throw new OpError(409, 'missing_secret', 'Prima va creata la chiave segreta in Cloudflare (istruzioni qui sotto).');
  const clean = (v, max, label) => {
    if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw bad(`Scrivi ${label}`);
    return v.trim();
  };
  const cred = { utente: clean(p.utente, 60, 'l’utente'), password: clean(p.password, 120, 'la password'), wskey: clean(p.wskey, 400, 'la WsKey') };
  const sealed = await sealJson(env, purposeFor(house.id), cred);
  const at = nowIso();
  await db.prepare(`INSERT INTO house_secrets (house_id, alloggiati, set_at, set_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(house_id) DO UPDATE SET alloggiati = excluded.alloggiati, set_at = excluded.set_at, set_by = excluded.set_by`)
    .bind(house.id, sealed, at, user.email).run();
  // Dell'utente si mostra solo l'inizio, per riconoscerlo.
  const hint = `${cred.utente.slice(0, 3)}…`;
  const status = await setStatus(db, user, house, { configured: true, user_hint: hint, set_at: at, ok_at: undefined, error: undefined }, 'alloggiati_credenziali');
  // Prova subito il collegamento (senza inviare niente).
  const check = await checkConnection(db, env, user, { houseId: house.id }, { fetchImpl }).catch((e) => ({ ok: false, error: e.message, status }));
  return check;
}

export async function checkConnection(db, env, user, p, { fetchImpl = fetch } = {}) {
  const house = await getHouse(db, p.houseId);
  const cred = await credentialsFor(db, env, house.id);
  const client = alloggiatiClient(cred, { fetchImpl });
  try {
    await client.check();
  } catch (e) {
    const err = wsFail(e);
    const status = await setStatus(db, user, house, { error: err.message, error_at: nowIso() });
    return { ok: false, error: err.message, status };
  }
  let tables = null;
  const st = parseStatus(house);
  const old = !st.tables_at || st.tables_at < new Date(Date.now() - TABLES_MAX_AGE_DAYS * 86400000).toISOString();
  const empty = (await db.prepare('SELECT COUNT(*) AS n FROM places').first()).n === 0;
  if (old || empty || p.tables) {
    try {
      tables = await loadTables(db, client);
    } catch (e) {
      const err = wsFail(e);
      const status = await setStatus(db, user, house, { ok_at: nowIso(), error: `Accesso riuscito, ma ${err.message}`, error_at: nowIso() });
      return { ok: false, error: status.error, status };
    }
  }
  const status = await setStatus(db, user, house, { ok_at: nowIso(), error: undefined, error_at: undefined, ...(tables ? { tables_at: nowIso() } : {}) });
  return { ok: true, status, tables };
}

/** Scarica e salva le tabelle ufficiali (luoghi e tipi di documento). */
export async function loadTables(db, client) {
  const places = parsePlaces(await client.table('Luoghi'));
  const docs = parseDocTypes(await client.table('Tipi_Documento'));
  if (places.length < 100 || docs.length < 3) throw new WsError('table', 'le tabelle ufficiali scaricate sono incomplete');
  const stmts = [db.prepare('DELETE FROM places'), db.prepare('DELETE FROM doc_types')];
  // D1: al massimo 100 valori per istruzione → 20 luoghi (5 valori) per riga di inserimento.
  for (let i = 0; i < places.length; i += 20) {
    const chunk = places.slice(i, i + 20);
    stmts.push(db.prepare(`INSERT OR REPLACE INTO places (code, name, province, kind, active) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...chunk.flatMap((x) => [x.code, x.name, x.province, x.kind, x.active])));
  }
  for (let i = 0; i < docs.length; i += 50) {
    const chunk = docs.slice(i, i + 50);
    stmts.push(db.prepare(`INSERT OR REPLACE INTO doc_types (code, name) VALUES ${chunk.map(() => '(?, ?)').join(', ')}`).bind(...chunk.flatMap((x) => [x.code, x.name])));
  }
  // Tutto in un'unica transazione (a blocchi non si può: una tabella a metà sarebbe peggio di quella vecchia).
  await db.batch(stmts);
  return { places: places.length, docs: docs.length };
}

/* ------------------------------ Luoghi ------------------------------ */

/**
 * Ricerca di luoghi per nome (comuni italiani e/o stati). Prima quelli validi oggi; poi anche quelli che non
 * esistono più (servono per chi è nato in un comune poi soppresso o fuso), segnati come tali.
 */
export async function searchPlaces(db, q, kind) {
  const text = String(q || '').trim().toUpperCase().replace(/\s+/g, ' ').slice(0, 40);
  if (text.length < 2) return [];
  const kinds = kind === 'C' ? ['C'] : kind === 'S' ? ['S'] : ['C', 'S'];
  const r = await db.prepare(`SELECT code, name, province, kind, active FROM places
    WHERE kind IN (${kinds.map(() => '?').join(', ')}) AND (UPPER(TRIM(name)) LIKE ? OR UPPER(name) LIKE ? OR UPPER(name) LIKE ?)
    ORDER BY active DESC, CASE WHEN UPPER(TRIM(name)) = ? THEN 0 WHEN UPPER(TRIM(name)) LIKE ? THEN 1 ELSE 2 END, kind DESC, name LIMIT 15`)
    .bind(...kinds, `${text}%`, `% ${text}%`, `%-${text}%`, text, `${text}%`).all();
  return r.results || [];
}

/** Riassunto delle tabelle ufficiali (per l'amministratore): quanti comuni e stati, validi e non. */
export async function placesStats(db) {
  const rows = (await db.prepare('SELECT kind, active, COUNT(*) AS n FROM places GROUP BY kind, active').all()).results || [];
  const get = (k, a) => (rows.find((x) => x.kind === k && x.active === a) || { n: 0 }).n;
  const docs = (await db.prepare('SELECT COUNT(*) AS n FROM doc_types').first()).n;
  return { comuni: get('C', 1), comuniSoppressi: get('C', 0), stati: get('S', 1), statiSoppressi: get('S', 0), documenti: docs };
}

export async function docTypes(db) {
  const r = await db.prepare('SELECT code, name FROM doc_types ORDER BY name').all();
  return r.results || [];
}

async function placeLookup(db, codes) {
  const list = [...new Set(codes.filter(Boolean))];
  if (!list.length) return () => null;
  const r = await db.prepare(`SELECT code, kind, province FROM places WHERE code IN (${list.map(() => '?').join(', ')})`).bind(...list).all();
  const map = new Map((r.results || []).map((x) => [x.code, x]));
  return (code) => map.get(code) || null;
}

/* ------------------------------ File PS per SPOT Easy (DMS Puglia) ------------------------------ */

/**
 * File "PS" per SPOT Easy (DMS Puglia per le locazioni turistiche: «Carica file PS»): è il file .txt delle
 * schedine Alloggiati, una riga di 168 caratteri per ospite (capo per primo), righe chiuse da CR LF.
 * Si può creare finché ci sono i dati del documento del capo: dopo la ricevuta della Questura vengono cancellati
 * e allora l'arrivo su SPOT Easy si inserisce a mano (l'app mostra i dati che servono).
 */
export async function spotFile(db, bookingId, { today = todayRome() } = {}) {
  if (!isId(bookingId)) throw bad('Richiesta non valida');
  const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first();
  if (!b) throw new OpError(404, 'not_found', 'Prenotazione non trovata.');
  if (b.stage === 'cancellata') throw new OpError(409, 'state', 'Prenotazione cancellata.');
  const guests = await listGuests(db, b.id);
  if (!guests.length) throw new OpError(409, 'guests', 'Inserisci prima i dati degli ospiti.');
  if (guests.length !== b.guests) throw new OpError(409, 'guests', `Ospiti inseriti: ${guests.length}; nella prenotazione: ${b.guests}.`);
  if (guests[0].doc_purged_at) {
    throw new OpError(409, 'purged', 'Il documento del capo è già stato cancellato dopo la ricevuta della Questura: inserisci l’arrivo a mano su SPOT Easy.');
  }
  const incomplete = guests.map((g, i) => ({ g, miss: guestMissing(g, i === 0, { today }) })).filter((x) => x.miss.length);
  if (incomplete.length) throw new OpError(409, 'guests', `Dati incompleti: ${incomplete.map((x) => `${x.g.first_name} ${x.g.last_name} (${x.miss.join(', ')})`).join('; ')}.`);
  const place = await placeLookup(db, guests.flatMap((g) => [g.birth_place, g.doc_place]));
  let rows;
  try {
    rows = bookingSchedine(b, guests, place);
  } catch (e) {
    throw new OpError(409, 'guests', `${e.message}.`);
  }
  const surname = guests[0].last_name ? String(guests[0].last_name).normalize('NFD').replace(/[^A-Za-z0-9]+/g, '').slice(0, 20) : 'ospite';
  return {
    text: `${rows.map((x) => x.row).join('\r\n')}\r\n`,
    filename: `SPOT-${b.house_id}-${b.check_in}-${surname || 'ospite'}.txt`,
    count: rows.length,
  };
}

/* ------------------------------ Invio delle schedine ------------------------------ */

/**
 * Invia le schedine di una prenotazione. Prima le fa controllare al portale (Test): se anche una sola è
 * sbagliata non si invia niente e si mostra l'errore. Una prenotazione già inviata non si reinvia
 * senza conferma esplicita (again: true). Due invii insieme dallo stesso gestionale non partono mai.
 */
export async function sendSchedine(db, env, user, p, { fetchImpl = fetch, today = todayRome() } = {}) {
  if (!isId(p.bookingId)) throw bad('Richiesta non valida');
  const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(p.bookingId).first();
  if (!b) throw new OpError(404, 'not_found', 'Prenotazione non trovata.');
  if (!['confermata', 'in_casa', 'partita'].includes(b.stage)) throw new OpError(409, 'state', 'Le schedine si inviano al check-in.');
  const win = sendWindow(b.check_in, today);
  if (!win.ok) throw new OpError(409, 'window', win.text);
  if (b.alloggiati_at && !p.again) throw new OpError(409, 'already', 'Le schedine di questa prenotazione sono già state inviate.', { at: b.alloggiati_at });
  const guests = await listGuests(db, b.id);
  if (!guests.length) throw new OpError(409, 'guests', 'Inserisci prima i dati degli ospiti.');
  if (guests.length !== b.guests) throw new OpError(409, 'guests', `Ospiti inseriti: ${guests.length}; nella prenotazione: ${b.guests}. Correggi il numero o aggiungi chi manca.`);
  const incomplete = guests.map((g, i) => ({ g, miss: guestMissing(g, i === 0, { today }) })).filter((x) => x.miss.length);
  if (incomplete.length) throw new OpError(409, 'guests', `Dati incompleti: ${incomplete.map((x) => `${x.g.first_name} ${x.g.last_name} (${x.miss.join(', ')})`).join('; ')}.`);
  const place = await placeLookup(db, guests.flatMap((g) => [g.birth_place, g.doc_place]));
  let rows;
  try {
    rows = bookingSchedine(b, guests, place);
  } catch (e) {
    throw new OpError(409, 'guests', `${e.message}.`);
  }
  const cred = await credentialsFor(db, env, b.house_id);

  // Blocco: un solo invio alla volta per prenotazione.
  const at = nowIso();
  const lock = await db.prepare(`UPDATE bookings SET alloggiati_error = ? WHERE id = ?
    AND (alloggiati_error IS NULL OR alloggiati_error NOT LIKE 'IN_CORSO:%' OR alloggiati_error < ?)`)
    .bind(`IN_CORSO:${at}`, b.id, `IN_CORSO:${new Date(Date.now() - LOCK_MS).toISOString()}`).run();
  if (lock.meta.changes !== 1) throw new OpError(409, 'busy', 'Invio già in corso da un altro dispositivo: aspetta un minuto.');

  const client = alloggiatiClient(cred, { fetchImpl });
  const finish = async (fields, action, changes) => {
    const cols = Object.keys(fields);
    const main = db.prepare(`UPDATE bookings SET ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ?`)
      .bind(...cols.map((c) => fields[c]), nowIso(), user.email, b.id);
    await commit(db, { main, user, opId: crypto.randomUUID(), entity: 'booking', entityId: b.id, action, changes });
    return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first();
  };
  const describe = (res) => res.details.map((d, i) => (d.ok ? null : { guest: `${guests[i]?.first_name || ''} ${guests[i]?.last_name || ''}`.trim(), error: esitoText(d) })).filter(Boolean);

  try {
    const test = await client.test(rows.map((x) => x.row));
    if (!test.ok) {
      const errors = describe(test);
      const msg = errors.length ? errors.map((x) => `${x.guest}: ${x.error}`).join('; ') : esitoText(test.overall);
      const record = await finish({ alloggiati_error: `Controllo del portale: ${msg}`.slice(0, 500) }, 'alloggiati_errore', { esito: 'schedine rifiutate dal controllo' });
      return { ok: false, stage: 'test', errors, message: `Il portale ha trovato degli errori, non ho inviato niente. ${msg}`, record };
    }
    const sent = await client.send(rows.map((x) => x.row));
    if (!sent.ok) {
      const errors = describe(sent);
      const msg = errors.length ? errors.map((x) => `${x.guest}: ${x.error}`).join('; ') : esitoText(sent.overall);
      const record = await finish({ alloggiati_error: `Invio: ${sent.valid} di ${rows.length} accettate. ${msg}`.slice(0, 500) }, 'alloggiati_errore',
        { esito: `${sent.valid} di ${rows.length} accettate` });
      return { ok: false, stage: 'send', accepted: sent.valid, errors, message: `Accettate ${sent.valid} schedine su ${rows.length}. ${msg}`, record };
    }
    const record = await finish({
      alloggiati_at: nowIso(), alloggiati_by: user.email, alloggiati_count: rows.length, alloggiati_error: null,
      checkin_steps: JSON.stringify({ ...JSON.parse(b.checkin_steps || '{}'), alloggiati: 1 }),
    }, 'alloggiati_invio', { schedine: rows.length });
    await db.prepare('UPDATE guests SET sent_at = ? WHERE booking_id = ? AND deleted = 0').bind(record.alloggiati_at, b.id).run();
    return { ok: true, count: rows.length, record };
  } catch (e) {
    const err = wsFail(e);
    const record = await finish({ alloggiati_error: err.message.slice(0, 500) }, 'alloggiati_errore', { esito: 'collegamento non riuscito' });
    if (err instanceof OpError) return { ok: false, stage: 'connection', message: err.message, record };
    throw err;
  }
}

/* ------------------------------ Ricevute ------------------------------ */

async function sha256Hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Scarica e salva la ricevuta di un giorno per una casa. Poi cancella i dati dei documenti di quel giorno. */
export async function fetchReceipt(db, env, houseId, date, { fetchImpl = fetch, client } = {}) {
  if (!isIsoDate(date)) throw bad('Data non valida');
  const have = await db.prepare('SELECT id FROM alloggiati_receipts WHERE house_id = ? AND date = ?').bind(houseId, date).first();
  if (have) return { ok: true, id: have.id, existing: true };
  const c = client || alloggiatiClient(await credentialsFor(db, env, houseId), { fetchImpl });
  const { pdf, esito } = await c.receipt(date);
  if (!pdf) return { ok: false, none: true, message: `Nessuna ricevuta per il ${date.split('-').reverse().join('/')}${esito && esito.desc ? ` (${esitoText(esito)})` : ''}.` };
  const id = crypto.randomUUID();
  const [y, m, d] = date.split('-');
  await db.prepare(`INSERT OR IGNORE INTO alloggiati_receipts (id, house_id, date, pdf, size, sha256, fetched_at, purge_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, houseId, date, pdf, pdf.length, await sha256Hex(pdf), nowIso(), `${Number(y) + RECEIPT_YEARS}-${m}-${d}`).run();
  await purgeDocsForDay(db, houseId, date);
  return { ok: true, id };
}

/** Il giorno (ora italiana) di un istante ISO. */
export function romeDay(iso) {
  return todayRome(new Date(iso));
}

/** Dati dei documenti non più necessari: la ricevuta della Questura è il documento da conservare. */
async function purgeDocsForDay(db, houseId, date) {
  const r = await db.prepare(`SELECT g.id, b.alloggiati_at FROM guests g JOIN bookings b ON b.id = g.booking_id
    WHERE b.house_id = ? AND b.alloggiati_at IS NOT NULL AND g.doc_number IS NOT NULL AND g.deleted = 0`).bind(houseId).all();
  const ids = (r.results || []).filter((x) => romeDay(x.alloggiati_at) === date).map((x) => x.id);
  if (!ids.length) return 0;
  await db.batch(ids.map((id) => db.prepare('UPDATE guests SET doc_type = NULL, doc_number = NULL, doc_place = NULL, doc_purged_at = ? WHERE id = ?').bind(nowIso(), id)));
  return ids.length;
}

/**
 * Lavoro automatico (ogni 30 minuti): ricevute mancanti dei giorni di invio (ultimi 30 giorni, oggi escluso),
 * cancellazione delle ricevute oltre i 5 anni. Restituisce un riassunto.
 */
export async function receiptJob(db, env, { fetchImpl = fetch, today = todayRome(), download = true } = {}) {
  const out = { fetched: 0, missing: [], errors: [], purged: 0 };
  out.purged = (await db.prepare('DELETE FROM alloggiati_receipts WHERE purge_after < ?').bind(today).run()).meta.changes || 0;
  if (!hasSecret(env) || !download) return out;
  const since = new Date(Date.now() - 31 * 86400000).toISOString();
  const sent = (await db.prepare('SELECT house_id, alloggiati_at FROM bookings WHERE alloggiati_at IS NOT NULL AND alloggiati_at >= ?').bind(since).all()).results || [];
  const want = new Map();
  for (const s of sent) {
    const day = romeDay(s.alloggiati_at);
    if (day >= today || day < addDays(today, -30)) continue;
    want.set(`${s.house_id}|${day}`, { house: s.house_id, day });
  }
  for (const { house, day } of want.values()) {
    const have = await db.prepare('SELECT 1 FROM alloggiati_receipts WHERE house_id = ? AND date = ?').bind(house, day).first();
    if (have) continue;
    try {
      const r = await fetchReceipt(db, env, house, day, { fetchImpl });
      if (r.ok) out.fetched += 1; else out.missing.push(`${house} ${day}`);
    } catch (e) {
      out.errors.push(`${house} ${day}: ${e.message}`);
    }
  }
  // Ricevute che stanno per sparire dal portale (oltre 25 giorni): avviso nello stato della casa.
  for (const h of (await db.prepare('SELECT * FROM houses').all()).results || []) {
    const late = [...want.values()].filter((w) => w.house === h.id && w.day <= addDays(today, -25));
    const missingLate = [];
    for (const w of late) {
      if (!(await db.prepare('SELECT 1 FROM alloggiati_receipts WHERE house_id = ? AND date = ?').bind(w.house, w.day).first())) missingLate.push(w.day);
    }
    const st = parseStatus(h);
    const text = missingLate.length ? `Ricevute non ancora scaricate: ${missingLate.map((x) => x.split('-').reverse().join('/')).join(', ')} (il portale le tiene 30 giorni).` : undefined;
    if ((st.receipt_warning || undefined) !== text) await setStatus(db, SYSTEM, h, { receipt_warning: text }, 'alloggiati_ricevute');
  }
  return out;
}

export async function readReceipt(db, id) {
  if (!isId(id)) throw bad('Richiesta non valida');
  const r = await db.prepare('SELECT house_id, date, pdf FROM alloggiati_receipts WHERE id = ?').bind(id).first();
  if (!r) throw new OpError(404, 'not_found', 'Ricevuta non trovata.');
  return r;
}
