// File per il DMS Puglia (SPOT Online → "Carica movimentazione").
//
// Formato: specifiche "SPOT online – file XML" (movimentogiornaliero-0.6.xsd):
//   <movimenti vendor="…"> con un <movimento type="MP|NM" data="aaaa-mm-gg"> per OGNI giorno, senza salti.
//   MP = ci sono arrivi o partenze; NM = nessun movimento. In ogni giorno <datistruttura> (camere e posti letto).
//   Arrivo: codice interno dell'ospite (mai dati anagrafici), sesso, cittadinanza, residenza (comune italiano o
//   stato estero), posto letto, day use, tipo (16 singolo, 17 capofamiglia, 18 capogruppo), età; i familiari e i
//   membri del gruppo vanno in <componenti>. Partenza: il codice del capo (o dell'ospite singolo).
// Nessun nome o documento nel file.

import { OpError, REV_NEXT, commit, publicHouse, registerOps } from './ops.js';
import { ageOn, guestType } from '../public/shared/alloggiati.js';
import { addDays, daysBetween, isIsoDate, todayRome } from '../public/shared/dates.js';

const MAX_DAYS = 92;
const bad = (m) => new OpError(400, 'validation', m);

export function parseDms(house) {
  try { return house && house.dms_settings ? JSON.parse(house.dms_settings) : {}; } catch { return {}; }
}

/** Controllo delle impostazioni DMS di una casa (camere, posti letto, ultimo giorno caricato). */
export function checkDmsSettings(input, house) {
  const v = {};
  const int = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
  if (!int(input.rooms, 1, 50)) return { ok: false, error: 'Numero di camere non valido' };
  if (!int(input.beds, 1, 100)) return { ok: false, error: 'Numero di posti letto non valido' };
  if (input.rooms > input.beds) return { ok: false, error: 'Le camere non possono essere più dei posti letto' };
  v.rooms = input.rooms;
  v.beds = input.beds;
  if (input.sent_until !== null && input.sent_until !== undefined && input.sent_until !== '') {
    if (!isIsoDate(input.sent_until)) return { ok: false, error: 'Data non valida' };
    v.sent_until = input.sent_until;
  } else v.sent_until = null;
  return { ok: true, value: { ...parseDms(house), ...v } };
}

const x = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function person(g, b, type, inner) {
  const residence = g.residence_kind === 'C' ? `<comuneresidenza>${g.residence}</comuneresidenza>` : `<paeseresidenza>${g.residence}</paeseresidenza>`;
  const head = `<codiceclientesr>${g.code}</codiceclientesr><sesso>${g.sex}</sesso><cittadinanza>${g.citizenship}</cittadinanza>${residence}`
    + '<occupazionepostoletto>si</occupazionepostoletto>';
  const age = `<eta>${ageOn(g.birth_date, b.check_in)}</eta>`;
  if (!type) return `<componente>${head}${age}</componente>`;
  return `<arrivo>${head}<dayuse>no</dayuse><tipologiaalloggiato>${type}</tipologiaalloggiato>${age}${inner}</arrivo>`;
}

/**
 * XML del periodo [from, to] per una casa. data: { house, bookings, guestsByBooking } (ospiti già con residence_kind).
 * Lancia OpError se mancano dati: il file non deve mai essere incompleto.
 */
export function buildDmsXml({ house, bookings, guestsByBooking, from, to }) {
  const dms = parseDms(house);
  if (!dms.rooms || !dms.beds) throw new OpError(409, 'dms_settings', 'Imposta camere e posti letto della casa per il DMS (Impostazioni → Case → DMS Puglia).');
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw bad('Periodo non valido');
  if (daysBetween(from, to) >= MAX_DAYS) throw bad(`Al massimo ${MAX_DAYS} giorni per file`);
  const active = bookings.filter((b) => b.house_id === house.id && b.stage !== 'cancellata');
  const problems = [];
  const groupFor = (b) => {
    const list = (guestsByBooking.get(b.id) || []).slice().sort((p, q) => p.position - q.position);
    if (list.length !== b.guests) problems.push(`${b.guest_name}: ospiti inseriti ${list.length} su ${b.guests}`);
    for (const g of list) {
      if (!g.sex || !g.citizenship || !g.residence || !g.residence_kind || ageOn(g.birth_date, b.check_in) === null) {
        problems.push(`${b.guest_name}: dati di ${g.first_name} incompleti (sesso, cittadinanza, residenza o data di nascita)`);
        break;
      }
    }
    return list;
  };
  // Una prenotazione già in casa il giorno prima dell'inizio, mai comunicata: il DMS non la conoscerebbe alla partenza.
  if (!dms.sent_until) {
    const across = active.filter((b) => b.check_in < from && b.check_out > from);
    if (across.length) problems.push(`Il ${from.split('-').reverse().join('/')} c'è già qualcuno in casa (${across.map((b) => b.guest_name).join(', ')}): per il primo file scegli un giorno in cui la casa è vuota`);
  }
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const arrivals = active.filter((b) => b.check_in === d);
    const departures = active.filter((b) => b.check_out === d);
    const occupied = active.some((b) => b.check_in <= d && d < b.check_out);
    const struttura = `<datistruttura><cameredisponibili>${dms.rooms}</cameredisponibili><postilettodisponibili>${dms.beds}</postilettodisponibili><camereoccupate>${occupied ? dms.rooms : 0}</camereoccupate></datistruttura>`;
    if (!arrivals.length && !departures.length) {
      days.push(`<movimento type="NM" data="${d}">${struttura}</movimento>`);
      continue;
    }
    let arr = '';
    for (const b of arrivals) {
      const list = groupFor(b);
      if (!list.length) continue;
      const type = guestType(0, list.length, b.guest_group);
      const members = list.slice(1).map((g) => person(g, b, null, '')).join('');
      arr += person(list[0], b, type, members ? `<componenti>${members}</componenti>` : '');
    }
    let dep = '';
    for (const b of departures) {
      const list = (guestsByBooking.get(b.id) || []).slice().sort((p, q) => p.position - q.position);
      if (!list.length) { problems.push(`${b.guest_name}: mancano gli ospiti (partenza del ${d.split('-').reverse().join('/')})`); continue; }
      dep += `<codiceclientesr>${list[0].code}</codiceclientesr>`;
    }
    days.push(`<movimento type="MP" data="${d}">${arr ? `<arrivi>${arr}</arrivi>` : ''}${dep ? `<partenze>${dep}</partenze>` : ''}${struttura}</movimento>`);
  }
  if (problems.length) throw new OpError(409, 'dms_data', `Non posso preparare il file: ${[...new Set(problems)].join('; ')}.`, { problems: [...new Set(problems)] });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<movimenti vendor="${x('DigiHome')}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="movimentogiornaliero-0.6.xsd">${days.join('')}</movimenti>\n`;
}

/** Legge dal database e prepara il file del periodo. */
export async function dmsFile(db, houseId, from, to) {
  const house = await db.prepare('SELECT * FROM houses WHERE id = ?').bind(houseId).first();
  if (!house) throw new OpError(404, 'not_found', 'Casa non trovata.');
  const bookings = (await db.prepare(`SELECT * FROM bookings WHERE house_id = ? AND stage <> 'cancellata'
    AND check_out >= ? AND check_in <= ?`).bind(houseId, addDays(from, -60), to).all()).results || [];
  const ids = bookings.map((b) => b.id);
  const guestsByBooking = new Map();
  if (ids.length) {
    const rows = (await db.prepare(`SELECT g.*, p.kind AS residence_kind FROM guests g LEFT JOIN places p ON p.code = g.residence
      WHERE g.deleted = 0 AND g.booking_id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all()).results || [];
    for (const g of rows) {
      if (!guestsByBooking.has(g.booking_id)) guestsByBooking.set(g.booking_id, []);
      guestsByBooking.get(g.booking_id).push(g);
    }
  }
  return { house, xml: buildDmsXml({ house, bookings, guestsByBooking, from, to }) };
}

/** Impostazioni DMS (solo amministratore) e "caricato fino al" (tutti: lo fa chi carica il file). */
export async function dmsSettingsOp(db, user, opId, p) {
  const house = await db.prepare('SELECT * FROM houses WHERE id = ?').bind(p.houseId).first();
  if (!house) throw new OpError(404, 'not_found', 'Casa non trovata.');
  const cur = parseDms(house);
  let next;
  if (p.sentOnly) {
    if (!isIsoDate(p.sent_until) || p.sent_until > todayRome()) throw bad('Data non valida');
    next = { ...cur, sent_until: p.sent_until };
  } else {
    if (user.role !== 'admin') throw new OpError(403, 'forbidden', 'Solo l’amministratore può farlo.');
    const c = checkDmsSettings(p, house);
    if (!c.ok) throw bad(c.error);
    next = c.value;
  }
  const main = db.prepare(`UPDATE houses SET dms_settings = ?, version = version + 1, rev = ${REV_NEXT}, updated_at = ?, updated_by = ? WHERE id = ?`)
    .bind(JSON.stringify(next), new Date().toISOString(), user.email, house.id);
  await commit(db, { main, user, opId, entity: 'house', entityId: house.id, action: 'dms', changes: { dms: next } });
  // File caricato: il passaggio "DMS Puglia" del check-in si spunta da solo per gli arrivi del periodo.
  if (p.sentOnly) {
    const from = cur.sent_until ? addDays(cur.sent_until, 1) : addDays(p.sent_until, -92);
    await db.batch([
      db.prepare(`UPDATE bookings SET checkin_steps = json_set(COALESCE(checkin_steps, '{}'), '$.dms', 1), rev = ${REV_NEXT}
        WHERE house_id = ? AND stage <> 'cancellata' AND check_in BETWEEN ? AND ? AND json_extract(COALESCE(checkin_steps, '{}'), '$.dms') IS NOT 1`)
        .bind(house.id, from, p.sent_until),
      db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'"),
    ]);
  }
  return { record: publicHouse(await db.prepare('SELECT * FROM houses WHERE id = ?').bind(house.id).first(), user.role === 'admin') };
}

registerOps({ 'house.dms': dmsSettingsOp });
