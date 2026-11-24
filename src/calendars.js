// Aggiornamento automatico dalle piattaforme (Airbnb, Booking) tramite il loro calendario iCal.
//
// Regole:
// - Ogni evento del calendario è una prenotazione, tranne i blocchi di Airbnb ("Not available"),
//   che sono date chiuse a mano o arrivate da altri calendari (es. da Booking).
// - Booking.com esporta tutte le date chiuse allo stesso modo: un evento di Booking coperto per intero
//   da prenotazioni di altri canali (es. Airbnb) è la loro copia e si ignora. Un evento di Booking di 28 notti
//   o più è una chiusura (es. la casa chiusa fuori stagione), non una prenotazione: si ignora.
// - Prenotazione nuova → si crea con "dati da completare" (le piattaforme non danno nome, ospiti, telefono).
//   Se c'è già la stessa prenotazione inserita a mano (stesso canale e stesse date) si collega quella.
// - Date cambiate → si aggiornano (prima dell'arrivo; durante il soggiorno solo la partenza).
// - Prenotazione futura sparita dal calendario → cancellata in automatico, con avviso e possibilità di ripristino.
//   Se il calendario arriva vuoto non si cancella nulla: si segnala da verificare.
// - Le prenotazioni passate non si importano e non si toccano.
// - Booking rilegge il calendario di DigiHome solo ogni qualche ora: le date di una prenotazione di un altro canale
//   cancellata o spostata da poco (48 ore) possono essere ancora chiuse su Booking → sono la sua copia, non una
//   prenotazione nuova.
// - Se dal calendario sparisce più della metà delle prenotazioni future (e più di 2), o restano solo blocchi,
//   non si cancella niente: si segnala da verificare (link sbagliato, annuncio sospeso, errore della piattaforma).

import { parseIcs, isBlock, airbnbInfo } from './ical.js';
import { commit, REV_NEXT } from './ops.js';
import { SYSTEM_EMAIL } from '../public/shared/calendar.js';
import { addDays, daysBetween, overlaps, todayRome } from '../public/shared/dates.js';
import { occupiedNights } from '../public/shared/booking.js';

const SYSTEM = { email: SYSTEM_EMAIL };
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const LABEL = { airbnb: 'Airbnb', booking: 'Booking' };
const CLOSURE_NIGHTS = 28; // Booking: da qui in su è una chiusura delle date, non un soggiorno
const RECENT_MS = 48 * 60 * 60 * 1000; // copie di Booking ancora "vecchie": prenotazioni cambiate nelle ultime 48 ore
const codeOf = (url) => (/\/details\/([A-Z0-9]{6,14})\b/.exec(url || '') || [])[1] || null;

/** Notti liberate da poco da prenotazioni degli altri canali (cancellate o con le date cambiate nelle ultime 48 ore). */
async function recentlyFreedNights(db, rows, ch, now = Date.now()) {
  const since = new Date(now - RECENT_MS).toISOString();
  const others = rows.filter((b) => b.channel !== ch);
  const out = new Set();
  const addRange = (a, b) => { if (a && b && a < b) for (let d = a; d < b; d = addDays(d, 1)) out.add(d); };
  for (const b of others) if (b.stage === 'cancellata' && (b.updated_at || '') >= since) addRange(b.check_in, b.check_out);
  if (others.length) {
    const byId = new Map(others.map((b) => [b.id, b]));
    const log = (await db.prepare(`SELECT entity_id, changes FROM audit_log WHERE entity = 'booking' AND at >= ?
      AND (changes LIKE '%check_in%' OR changes LIKE '%check_out%')`).bind(since).all()).results || [];
    for (const x of log) {
      const cur = byId.get(x.entity_id);
      if (!cur) continue;
      let c;
      try { c = JSON.parse(x.changes || '{}'); } catch { continue; }
      if (!Array.isArray(c.check_in) && !Array.isArray(c.check_out)) continue;
      addRange(Array.isArray(c.check_in) ? c.check_in[0] : cur.check_in, Array.isArray(c.check_out) ? c.check_out[0] : cur.check_out);
    }
  }
  return out;
}

class SyncError extends Error {}

function nowIso() {
  return new Date().toISOString();
}

async function download(url, fetcher) {
  let res;
  try {
    res = await fetcher(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'User-Agent': 'DigiHome-calendario/1.0' },
    });
  } catch {
    throw new SyncError('La piattaforma non risponde. Riprovo più tardi.');
  }
  if (res.status === 404 || res.status === 410 || res.status === 401 || res.status === 403) {
    throw new SyncError('Il link non funziona più: copialo di nuovo dalla piattaforma.');
  }
  if (!res.ok) throw new SyncError(`La piattaforma non risponde (errore ${res.status}). Riprovo più tardi.`);
  const len = Number(res.headers.get('Content-Length') || 0);
  if (len > MAX_BYTES) throw new SyncError('Calendario troppo grande.');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new SyncError('Calendario troppo grande.');
  return new TextDecoder('utf-8').decode(buf);
}

/** Scrive una modifica a una prenotazione come "Calendario automatico" (registro + contatore). */
async function write(db, b, set, changes, action) {
  const cols = Object.keys(set);
  const main = db.prepare(`UPDATE bookings SET ${cols.map((c) => `${c} = ?`).join(', ')},
      version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ?
    WHERE id = ? AND version = ?`)
    .bind(...cols.map((c) => set[c]), nowIso(), SYSTEM_EMAIL, b.id, b.version);
  return commit(db, { main, user: SYSTEM, opId: crypto.randomUUID(), entity: 'booking', entityId: b.id, action, changes });
}

async function create(db, cal, ev) {
  const info = cal.channel === 'airbnb' ? airbnbInfo(ev) : { code: null, url: null };
  const id = crypto.randomUUID();
  const at = nowIso();
  const row = {
    id, house_id: cal.house_id, channel: cal.channel,
    guest_name: `Ospite ${LABEL[cal.channel]}${info.code ? ` (${info.code})` : ''}`,
    guests: 1, check_in: ev.start, check_out: ev.end,
    total_cents: 0, deposit_cents: 0, deposit_paid: 0, security_cents: 0, security_status: 'nessuna',
    linens: 1, towels: 0, minors_delegation: 'non_serve',
    ext_uid: ev.uid, ext_url: info.url, needs_details: 1, ext_gone: 0,
    booked_on: todayRome(), // per il ritmo delle prenotazioni: arriva dal calendario poche ore dopo la prenotazione
  };
  const cols = Object.keys(row);
  const main = db.prepare(`INSERT INTO bookings (${cols.join(', ')}, created_at, created_by, updated_at, updated_by, rev)
    VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ${REV_NEXT})`)
    .bind(...cols.map((c) => row[c]), at, SYSTEM_EMAIL, at, SYSTEM_EMAIL);
  const changes = { channel: row.channel, check_in: row.check_in, check_out: row.check_out, origine: `calendario ${LABEL[cal.channel]}` };
  return commit(db, { main, user: SYSTEM, opId: crypto.randomUUID(), entity: 'booking', entityId: id, action: 'create', changes });
}

function covered(ev, nights) {
  for (let d = ev.start; d < ev.end; d = addDays(d, 1)) if (!nights.has(d)) return false;
  return true;
}

/** Applica gli eventi del calendario alle prenotazioni di quella casa e piattaforma. */
export async function applyEvents(db, cal, events, today = todayRome()) {
  const ch = cal.channel;
  const out = { created: 0, updated: 0, cancelled: 0, flagged: 0, count: 0 };
  const rows = (await db.prepare('SELECT * FROM bookings WHERE house_id = ?').bind(cal.house_id).all()).results || [];
  const linked = rows.filter((b) => b.channel === ch && b.ext_uid);
  const byUid = new Map(linked.map((b) => [b.ext_uid, b]));

  // Lo stesso codice due volte nello stesso calendario: si tiene il primo (altrimenti l'aggiornamento si blocca).
  const seenUid = new Set();
  const reservations = events.filter((e) => !(ch === 'airbnb' ? isBlock(e)
    : e.status === 'CANCELLED' || daysBetween(e.start, e.end) >= CLOSURE_NIGHTS))
    .filter((e) => (seenUid.has(e.uid) ? false : (seenUid.add(e.uid), true)));
  const inFeed = new Set(reservations.map((e) => e.uid));
  const otherNights = occupiedNights(rows.filter((b) => b.channel !== ch), cal.house_id);
  if (ch === 'booking') for (const d of await recentlyFreedNights(db, rows, ch)) otherNights.add(d);
  const future = reservations.filter((e) => e.end > today && !(ch === 'booking' && covered(e, otherNights)));
  out.count = future.length;

  // Prenotazioni future collegate che non sono più nel calendario.
  const gone = linked.filter((b) => b.stage === 'confermata' && b.check_in > today && !inFeed.has(b.ext_uid));
  const futureLinked = linked.filter((b) => b.stage === 'confermata' && b.check_in > today).length;

  for (const ev of future) {
    const b = byUid.get(ev.uid);
    if (b) {
      const set = {};
      if (b.stage === 'cancellata') {
        // Era stata cancellata in automatico ed è ricomparsa: si ripristina.
        if (b.ext_gone === 1 && ev.start > today) Object.assign(set, { stage: b.prev_stage || 'confermata', prev_stage: 'cancellata', ext_gone: 0 });
        else continue;
      }
      if (b.stage === 'confermata' || set.stage) {
        if (b.check_in !== ev.start) set.check_in = ev.start;
        if (b.check_out !== ev.end) set.check_out = ev.end;
      } else if (b.stage === 'in_casa' && b.check_out !== ev.end && ev.end > b.check_in) {
        set.check_out = ev.end;
      }
      if (b.ext_gone === 1 && b.stage !== 'cancellata') set.ext_gone = 0;
      if (!Object.keys(set).length) continue;
      const changes = Object.fromEntries(Object.keys(set).map((k) => [k, [b[k] ?? null, set[k]]]));
      if (await write(db, b, set, changes, set.stage ? 'restore' : 'sync')) out.updated++;
      continue;
    }
    // Stessa prenotazione con un nuovo codice (es. date cambiate su Airbnb): si sposta quella vecchia. Solo se è
    // davvero la stessa: stesso codice di prenotazione di Airbnb, oppure (senza codici) stesso arrivo o stessa
    // partenza. Una cancellata e una nuova di un altro ospite sulle stesse date restano due prenotazioni diverse.
    const evCode = ch === 'airbnb' ? airbnbInfo(ev).code : null;
    const moved = gone.find((g) => {
      if (!overlaps(g.check_in, g.check_out, ev.start, ev.end)) return false;
      const gCode = codeOf(g.ext_url);
      if (evCode && gCode) return evCode === gCode;
      return g.check_in === ev.start || g.check_out === ev.end;
    });
    if (moved) {
      gone.splice(gone.indexOf(moved), 1);
      const set = { ext_uid: ev.uid, check_in: ev.start, check_out: ev.end, ext_gone: 0 };
      const changes = { check_in: [moved.check_in, ev.start], check_out: [moved.check_out, ev.end] };
      if (await write(db, moved, set, changes, 'sync')) out.updated++;
      continue;
    }
    // Già inserita a mano: la si collega.
    const manual = rows.find((m) => m.channel === ch && !m.ext_uid && m.stage !== 'cancellata'
      && m.check_in === ev.start && m.check_out === ev.end);
    if (manual) {
      const info = ch === 'airbnb' ? airbnbInfo(ev) : { url: null };
      if (await write(db, manual, { ext_uid: ev.uid, ext_url: info.url }, { collegata: [null, `calendario ${LABEL[ch]}`] }, 'sync')) out.updated++;
      manual.ext_uid = ev.uid;
      continue;
    }
    if (await create(db, cal, ev)) out.created++;
  }

  // Cancellate a mano nel gestionale ma ancora sulla piattaforma: quando spariscono anche dal calendario
  // della piattaforma (cancellate pure lì), l'avviso si toglie da solo.
  if (events.length > 0) {
    for (const c of linked) {
      if (c.stage === 'cancellata' && c.ext_cancel_warn === 1 && !inFeed.has(c.ext_uid)) {
        if (await write(db, c, { ext_cancel_warn: 0 }, { ext_cancel_warn: [1, 0], motivo: [null, `cancellata anche su ${LABEL[ch]}`] }, 'sync')) out.updated++;
      }
    }
  }

  // Si cancella solo se il calendario ha ancora prenotazioni vere e non ne è sparita la maggior parte in un colpo.
  const massGone = gone.length > 2 && gone.length * 2 > futureLinked;
  const trustFeed = reservations.length > 0 && !massGone;
  for (const g of gone) {
    if (trustFeed) {
      const set = { stage: 'cancellata', prev_stage: g.stage, ext_gone: 1 };
      const changes = { stage: [g.stage, 'cancellata'], motivo: [null, `non è più nel calendario ${LABEL[ch]}`] };
      if (await write(db, g, set, changes, 'cancel')) out.cancelled++;
    } else if (g.ext_gone !== 1) {
      if (await write(db, g, { ext_gone: 1 }, { ext_gone: [0, 1] }, 'sync')) out.flagged++;
    }
  }
  return out;
}

async function setStatus(db, id, fields, bump = true) {
  const cols = Object.keys(fields);
  if (!bump) {
    // Niente di nuovo da mostrare (stesso esito del giro prima): solo l'ora, senza far riscaricare i dispositivi.
    await db.prepare(`UPDATE calendars SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).bind(...cols.map((c) => fields[c]), id).run();
    return;
  }
  await db.batch([
    db.prepare(`UPDATE calendars SET ${cols.map((c) => `${c} = ?`).join(', ')}, rev = ${REV_NEXT} WHERE id = ?`)
      .bind(...cols.map((c) => fields[c]), id),
    db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'"),
  ]);
}

/** Aggiorna un calendario. Restituisce { ok, error?, created, updated, cancelled, flagged, count }. */
export async function syncCalendar(db, cal, { fetcher = fetch, today = todayRome() } = {}) {
  const at = nowIso();
  try {
    const parsed = parseIcs(await download(cal.import_url, fetcher));
    if (!parsed.ok) throw new SyncError(parsed.error);
    const res = await applyEvents(db, cal, parsed.events, today);
    const same = !cal.last_error && cal.last_count === res.count && cal.last_ok_at;
    await setStatus(db, cal.id, { last_sync_at: at, last_ok_at: at, last_error: null, last_count: res.count }, !same);
    return { ok: true, id: cal.id, ...res };
  } catch (e) {
    const error = e instanceof SyncError ? e.message : 'Aggiornamento non riuscito. Riprovo più tardi.';
    if (!(e instanceof SyncError)) console.error('Calendario', cal.id, e && e.stack ? e.stack : e);
    await setStatus(db, cal.id, { last_sync_at: at, last_error: error }, cal.last_error !== error);
    return { ok: false, id: cal.id, error };
  }
}

/**
 * Aggiorna tutti i calendari collegati (prima Airbnb, poi Booking, per riconoscere le copie).
 * minAgeMs: salta i calendari aggiornati da meno di questo tempo (per il pulsante "Aggiorna ora").
 */
export async function syncAll(db, { fetcher = fetch, today = todayRome(), minAgeMs = 0 } = {}) {
  const cals = (await db.prepare(`SELECT * FROM calendars WHERE import_url IS NOT NULL
    ORDER BY house_id, CASE channel WHEN 'airbnb' THEN 0 ELSE 1 END`).all()).results || [];
  const results = [];
  for (const cal of cals) {
    if (minAgeMs && cal.last_sync_at && Date.now() - Date.parse(cal.last_sync_at) < minAgeMs) {
      results.push({ ok: !cal.last_error, id: cal.id, skipped: true, error: cal.last_error || undefined });
      continue;
    }
    results.push(await syncCalendar(db, cal, { fetcher, today }));
  }
  return results;
}
