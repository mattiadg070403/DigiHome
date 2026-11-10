// Aggiornamento automatico dalle piattaforme (Airbnb, Booking) tramite il loro calendario iCal.
//
// Regole:
// - Ogni evento del calendario è una prenotazione, tranne i blocchi di Airbnb ("Not available"),
//   che sono date chiuse a mano o arrivate da altri calendari (es. da Booking).
// - Booking.com esporta tutte le date chiuse allo stesso modo: un evento di Booking coperto per intero
//   da prenotazioni di altri canali (es. Airbnb) è la loro copia e si ignora.
// - Prenotazione nuova → si crea con "dati da completare" (le piattaforme non danno nome, ospiti, telefono).
//   Se c'è già la stessa prenotazione inserita a mano (stesso canale e stesse date) si collega quella.
// - Date cambiate → si aggiornano (prima dell'arrivo; durante il soggiorno solo la partenza).
// - Prenotazione futura sparita dal calendario → cancellata in automatico, con avviso e possibilità di ripristino.
//   Se il calendario arriva vuoto non si cancella nulla: si segnala da verificare.
// - Le prenotazioni passate non si importano e non si toccano.

import { parseIcs, isBlock, airbnbInfo } from './ical.js';
import { commit, REV_NEXT } from './ops.js';
import { SYSTEM_EMAIL } from '../public/shared/calendar.js';
import { addDays, overlaps, todayRome } from '../public/shared/dates.js';
import { occupiedNights } from '../public/shared/booking.js';

const SYSTEM = { email: SYSTEM_EMAIL };
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const LABEL = { airbnb: 'Airbnb', booking: 'Booking' };

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

  const reservations = events.filter((e) => !(ch === 'airbnb' ? isBlock(e) : e.status === 'CANCELLED'));
  const inFeed = new Set(reservations.map((e) => e.uid));
  const otherNights = occupiedNights(rows.filter((b) => b.channel !== ch), cal.house_id);
  const future = reservations.filter((e) => e.end > today && !(ch === 'booking' && covered(e, otherNights)));
  out.count = future.length;

  // Prenotazioni future collegate che non sono più nel calendario.
  const gone = linked.filter((b) => b.stage === 'confermata' && b.check_in > today && !inFeed.has(b.ext_uid));

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
    // Stessa prenotazione con un nuovo codice (es. date cambiate su Airbnb): si sposta quella vecchia.
    const moved = gone.find((g) => overlaps(g.check_in, g.check_out, ev.start, ev.end));
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

  const feedHasEvents = events.length > 0;
  for (const g of gone) {
    if (feedHasEvents) {
      const set = { stage: 'cancellata', prev_stage: g.stage, ext_gone: 1 };
      const changes = { stage: [g.stage, 'cancellata'], motivo: [null, `non è più nel calendario ${LABEL[ch]}`] };
      if (await write(db, g, set, changes, 'cancel')) out.cancelled++;
    } else if (g.ext_gone !== 1) {
      if (await write(db, g, { ext_gone: 1 }, { ext_gone: [0, 1] }, 'sync')) out.flagged++;
    }
  }
  return out;
}

async function setStatus(db, id, fields) {
  const cols = Object.keys(fields);
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
    await setStatus(db, cal.id, { last_sync_at: at, last_ok_at: at, last_error: null, last_count: res.count });
    return { ok: true, id: cal.id, ...res };
  } catch (e) {
    const error = e instanceof SyncError ? e.message : 'Aggiornamento non riuscito. Riprovo più tardi.';
    if (!(e instanceof SyncError)) console.error('Calendario', cal.id, e && e.stack ? e.stack : e);
    await setStatus(db, cal.id, { last_sync_at: at, last_error: error });
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
