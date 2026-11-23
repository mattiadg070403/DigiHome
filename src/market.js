// Mercato: lavori su Apify (ricerca delle case simili e prezzi per settimana), letti a ogni giro dell'orologio.
// La chiave è il segreto di Cloudflare APIFY_TOKEN: resta sul server, non va mai nel database né all'app.
// Pochi lavori alla volta (piano gratuito: memoria limitata), costo stimato ~0,7 $ a settimana per le due case.

import { OpError, REV_NEXT, registerOps } from './ops.js';
import { addDays, todayRome } from '../public/shared/dates.js';
import { pricingSettings, seasonWeeks, seasonYear } from '../public/shared/pricing.js';
import { MAX_CANDIDATES, MAX_SELECTED, checkMarketSettings, marketSettings, readListing, similarity } from '../public/shared/market.js';

const API = 'https://api.apify.com/v2';
export const ACTOR_SEARCH = 'tri_angle~airbnb-scraper';
export const ACTOR_ROOMS = 'tri_angle~airbnb-rooms-urls-scraper';
const MAX_RUNNING = 3;
const RUN_TIMEOUT_MIN = 40;
const TIMEOUT_MS = 20000;

export const apifyReady = (env) => typeof env.APIFY_TOKEN === 'string' && env.APIFY_TOKEN.length >= 20;

const nowIso = () => new Date().toISOString();

/** Chiamate ad Apify (solo dal server). */
export function apifyClient(env, fetchImpl = fetch) {
  async function call(path, { method = 'GET', body } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method, signal: ctrl.signal,
        headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new OpError(502, 'apify', 'Apify non risponde. Riprovo al prossimo giro.');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const msg = data && data.error && data.error.message ? String(data.error.message).slice(0, 200) : `errore ${res.status}`;
      if (res.status === 401) throw new OpError(502, 'apify_auth', 'La chiave di Apify non è valida (controlla APIFY_TOKEN in Cloudflare).');
      if (res.status === 402) throw new OpError(502, 'apify_limit', 'Credito di Apify finito per questo mese (o troppi lavori insieme).');
      throw new OpError(502, 'apify', `Apify: ${msg}`);
    }
    return data;
  }
  return {
    async start(actor, input) {
      const d = await call(`/acts/${actor}/runs?memory=1024&timeout=900`, { method: 'POST', body: input });
      const run = d && d.data;
      if (!run || !run.id) throw new OpError(502, 'apify', 'Apify: risposta non riconosciuta.');
      return { runId: String(run.id), datasetId: run.defaultDatasetId ? String(run.defaultDatasetId) : null };
    },
    async run(runId) {
      const d = await call(`/actor-runs/${encodeURIComponent(runId)}`);
      const run = (d && d.data) || {};
      return { status: String(run.status || ''), datasetId: run.defaultDatasetId ? String(run.defaultDatasetId) : null };
    },
    async items(datasetId) {
      const d = await call(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=500`);
      return Array.isArray(d) ? d : [];
    },
  };
}

/* ------------------------------ Richieste dall'app ------------------------------ */

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new OpError(403, 'forbidden', 'Solo l’amministratore può farlo.');
}

async function houseOf(db, id) {
  const h = typeof id === 'string' ? await db.prepare('SELECT * FROM houses WHERE id = ?').bind(id).first() : null;
  if (!h) throw new OpError(404, 'not_found', 'Casa non trovata.');
  return h;
}

/** "Cerca case simili": un lavoro di ricerca per la casa (uno solo alla volta). */
export async function startDiscovery(db, env, user, houseId, opts = {}) {
  requireAdmin(user);
  if (!apifyReady(env)) throw new OpError(400, 'apify_missing', 'Manca la chiave di Apify (APIFY_TOKEN in Cloudflare).');
  const house = await houseOf(db, houseId);
  const s = marketSettings(house);
  if (s.lat === null) throw new OpError(400, 'validation', 'Imposta prima la posizione della casa (Impostazioni → Case → Mercato).');
  const busy = await db.prepare("SELECT 1 FROM market_jobs WHERE house_id = ? AND kind = 'search' AND status IN ('queued', 'running')").bind(house.id).first();
  if (!busy) {
    await db.prepare("INSERT INTO market_jobs (id, house_id, kind, status, created_at) VALUES (?, ?, 'search', 'queued', ?)")
      .bind(crypto.randomUUID(), house.id, nowIso()).run();
  }
  return marketTick(db, env, opts);
}

/** Settimane da controllare: quelle della stagione non ancora iniziate. */
function weeksToCheck(house, today) {
  const ps = pricingSettings(house);
  return seasonWeeks(seasonYear(today, ps), ps).filter((ws) => ws > today);
}

/** "Aggiorna i prezzi": un lavoro per ogni settimana futura della stagione (salta quelle già in coda). */
export async function requestRefresh(db, env, user, houseId, opts = {}) {
  requireAdmin(user);
  if (!apifyReady(env)) throw new OpError(400, 'apify_missing', 'Manca la chiave di Apify (APIFY_TOKEN in Cloudflare).');
  const house = await houseOf(db, houseId);
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM market_comps WHERE house_id = ? AND selected = 1').bind(house.id).first()).n;
  if (!n) throw new OpError(400, 'validation', 'Scegli prima le case simili da confrontare.');
  await enqueuePrices(db, house, opts.today || todayRome());
  return marketTick(db, env, opts);
}

async function enqueuePrices(db, house, today) {
  const pending = new Set(((await db.prepare("SELECT week_start FROM market_jobs WHERE house_id = ? AND kind = 'prices' AND status IN ('queued', 'running')")
    .bind(house.id).all()).results || []).map((r) => r.week_start));
  const at = nowIso();
  const stmts = weeksToCheck(house, today).filter((ws) => !pending.has(ws)).map((ws) => db.prepare(
    "INSERT INTO market_jobs (id, house_id, kind, week_start, status, created_at) VALUES (?, ?, 'prices', ?, 'queued', ?)")
    .bind(crypto.randomUUID(), house.id, ws, at));
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

/* ------------------------------ Giro dell'orologio ------------------------------ */

/**
 * A ogni giro: controlla i lavori in corso (e ne legge i risultati), mette in coda l'aggiornamento settimanale,
 * avvia i lavori in coda (al massimo 3 insieme). Restituisce un riassunto.
 */
export async function marketTick(db, env, { fetchImpl = fetch, today = todayRome(), maxPoll = 8, maxStart = 3 } = {}) {
  if (!apifyReady(env)) return { skipped: true };
  const api = apifyClient(env, fetchImpl);
  const out = { polled: 0, done: 0, failed: 0, started: 0, queued: 0 };
  // 1. Lavori in corso
  const running = (await db.prepare("SELECT * FROM market_jobs WHERE status = 'running' ORDER BY started_at LIMIT ?").bind(maxPoll).all()).results || [];
  for (const job of running) {
    out.polled += 1;
    try {
      const r = await api.run(job.run_id);
      if (r.status === 'SUCCEEDED') {
        const items = await api.items(r.datasetId || job.dataset_id);
        const n = job.kind === 'search' ? await saveSearch(db, job, items) : await savePrices(db, job, items);
        await finish(db, job, 'done', null, n);
        out.done += 1;
      } else if (['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMING-OUT', 'ABORTING'].includes(r.status)) {
        await retryOrFail(db, job, `Apify: lavoro ${r.status.toLowerCase()}`);
        out.failed += 1;
      } else if (Date.now() - Date.parse(job.started_at) > RUN_TIMEOUT_MIN * 60000) {
        await retryOrFail(db, job, 'Apify: lavoro troppo lungo');
        out.failed += 1;
      }
    } catch (e) {
      if (e instanceof OpError && e.code === 'apify_auth') { await finish(db, job, 'error', e.message, null); out.failed += 1; continue; }
      // Rete o Apify momentaneamente giù: si riprova al prossimo giro.
    }
  }
  // 2. Aggiornamento settimanale automatico (case con almeno una casa simile scelta)
  const houses = (await db.prepare(`SELECT h.* FROM houses h WHERE EXISTS (SELECT 1 FROM market_comps c WHERE c.house_id = h.id AND c.selected = 1)`).all()).results || [];
  for (const h of houses) {
    const last = await db.prepare("SELECT MAX(created_at) AS t FROM market_jobs WHERE house_id = ? AND kind = 'prices'").bind(h.id).first();
    if (!last.t || Date.now() - Date.parse(last.t) > 7 * 86400000) out.queued += await enqueuePrices(db, h, today);
  }
  // 3. Avvio dei lavori in coda
  const nowRunning = (await db.prepare("SELECT COUNT(*) AS n FROM market_jobs WHERE status = 'running'").first()).n;
  const free = Math.max(0, Math.min(maxStart, MAX_RUNNING - nowRunning));
  const queued = free ? ((await db.prepare("SELECT * FROM market_jobs WHERE status = 'queued' ORDER BY kind = 'search' DESC, created_at, week_start LIMIT ?").bind(free).all()).results || []) : [];
  for (const job of queued) {
    try {
      const input = await jobInput(db, job);
      if (!input) { await finish(db, job, 'error', 'Niente da cercare (case simili non scelte o posizione mancante).', 0); continue; }
      const r = await api.start(job.kind === 'search' ? ACTOR_SEARCH : ACTOR_ROOMS, input);
      await db.prepare("UPDATE market_jobs SET status = 'running', run_id = ?, dataset_id = ?, started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'")
        .bind(r.runId, r.datasetId, nowIso(), job.id).run();
      out.started += 1;
    } catch (e) {
      if (e instanceof OpError && ['apify_auth', 'apify_limit'].includes(e.code)) {
        await finish(db, job, 'error', e.message, null);
        out.error = e.message;
        break;
      }
      break; // Apify non raggiungibile: si riprova al prossimo giro
    }
  }
  return out;
}

async function finish(db, job, status, error, items) {
  await db.prepare('UPDATE market_jobs SET status = ?, error = ?, items = ?, finished_at = ? WHERE id = ?')
    .bind(status, error, items, nowIso(), job.id).run();
}

async function retryOrFail(db, job, error) {
  if (job.attempts < 2) await db.prepare("UPDATE market_jobs SET status = 'queued', run_id = NULL, dataset_id = NULL, error = ? WHERE id = ?").bind(error, job.id).run();
  else await finish(db, job, 'error', error, null);
}

/** Dati da mandare ad Apify per un lavoro. */
async function jobInput(db, job) {
  const house = await db.prepare('SELECT * FROM houses WHERE id = ?').bind(job.house_id).first();
  if (!house) return null;
  const s = marketSettings(house);
  if (job.kind === 'search') {
    if (s.lat === null) return null;
    return {
      locationQueries: [s.query], adults: Math.max(1, Math.min(16, house.max_guests - 2)),
      ...(s.bedrooms ? { minBedrooms: Math.max(0, s.bedrooms - 1) } : {}),
      currency: 'EUR', locale: 'en-US', maxResults: 120,
    };
  }
  const comps = (await db.prepare('SELECT listing_id, capacity FROM market_comps WHERE house_id = ? AND selected = 1').bind(house.id).all()).results || [];
  if (!comps.length) return null;
  const caps = comps.map((c) => c.capacity).filter((x) => Number.isInteger(x) && x > 0);
  const adults = Math.max(1, Math.min(house.max_guests, caps.length ? Math.min(...caps) : house.max_guests));
  return {
    startUrls: comps.map((c) => ({ url: `https://www.airbnb.com/rooms/${c.listing_id}` })),
    checkIn: job.week_start, checkOut: addDays(job.week_start, 7), adults, currency: 'EUR', locale: 'en-US',
  };
}

/** Risultati della ricerca → candidati (i 15 più simili). Se non c'era ancora una scelta, si scelgono i primi 10. */
export async function saveSearch(db, job, items) {
  const house = await db.prepare('SELECT * FROM houses WHERE id = ?').bind(job.house_id).first();
  const s = marketSettings(house);
  const seen = new Set();
  const ranked = [];
  for (const it of items) {
    const l = readListing(it);
    if (!l || seen.has(l.listing_id)) continue;
    seen.add(l.listing_id);
    const sim = similarity(l, { house, settings: s });
    if (sim) ranked.push({ ...l, ...sim });
  }
  ranked.sort((a, b) => a.score - b.score);
  const top = ranked.slice(0, MAX_CANDIDATES);
  const hadSelection = (await db.prepare('SELECT COUNT(*) AS n FROM market_comps WHERE house_id = ? AND selected = 1').bind(house.id).first()).n > 0;
  const at = nowIso();
  const keep = JSON.stringify(top.map((l) => l.listing_id));
  const stmts = [
    // Si tolgono i vecchi candidati non scelti che non sono più tra i più simili (quelli scelti restano).
    db.prepare(`DELETE FROM market_comps WHERE house_id = ? AND selected = 0 AND listing_id NOT IN (SELECT value FROM json_each(?))`).bind(house.id, keep),
    ...top.map((l, i) => db.prepare(`INSERT INTO market_comps (id, house_id, listing_id, url, title, capacity, bedrooms, distance_m, rating, reviews, amenities, score, selected, found_at, updated_at, rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})
        ON CONFLICT (house_id, listing_id) DO UPDATE SET title = excluded.title, capacity = excluded.capacity, bedrooms = excluded.bedrooms,
          distance_m = excluded.distance_m, rating = excluded.rating, reviews = excluded.reviews, amenities = excluded.amenities,
          score = excluded.score, updated_at = excluded.updated_at, rev = excluded.rev`)
      .bind(`${house.id}:${l.listing_id}`, house.id, l.listing_id, l.url, l.title, l.capacity, l.bedrooms, l.distance_m, l.rating, l.reviews,
        JSON.stringify(l.amenities), l.score, !hadSelection && i < MAX_SELECTED ? 1 : 0, at, at)),
    db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'"),
  ];
  await db.batch(stmts);
  return top.length;
}

/** Risultati di una settimana → prezzo o "non disponibile" per ogni casa scelta che Apify ha restituito. */
export async function savePrices(db, job, items) {
  const chosen = new Set(((await db.prepare('SELECT listing_id FROM market_comps WHERE house_id = ? AND selected = 1').bind(job.house_id).all()).results || []).map((r) => r.listing_id));
  const at = nowIso();
  const stmts = [];
  let n = 0;
  for (const it of items) {
    const l = readListing(it);
    if (!l || !chosen.has(l.listing_id) || (it && it.error)) continue;
    n += 1;
    stmts.push(db.prepare(`INSERT INTO market_prices (house_id, listing_id, week_start, status, week_cents, cleaning_cents, checked_at, rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})
        ON CONFLICT (house_id, listing_id, week_start) DO UPDATE SET status = excluded.status, week_cents = excluded.week_cents,
          cleaning_cents = excluded.cleaning_cents, checked_at = excluded.checked_at, rev = excluded.rev`)
      .bind(job.house_id, l.listing_id, job.week_start, l.available ? 'libera' : 'non_disponibile', l.available ? l.total_cents : null, l.cleaning_cents, at));
    // Dotazioni aggiornate dalla pagina dell'annuncio (più complete di quelle della ricerca).
    if (l.amenities.length) {
      stmts.push(db.prepare(`UPDATE market_comps SET amenities = ?, rating = COALESCE(?, rating), reviews = COALESCE(?, reviews), updated_at = ?, rev = ${REV_NEXT}
          WHERE house_id = ? AND listing_id = ?`).bind(JSON.stringify(l.amenities), l.rating, l.reviews, at, job.house_id, l.listing_id));
    }
  }
  if (stmts.length) await db.batch([...stmts, db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'")]);
  return n;
}

/* ------------------------------ Scelta delle case simili ------------------------------ */

async function marketSelect(db, user, opId, p) {
  requireAdmin(user);
  const house = await houseOf(db, p.house_id);
  const ids = Array.isArray(p.listing_ids) ? [...new Set(p.listing_ids.map(String))] : null;
  if (!ids || ids.length > MAX_SELECTED || ids.some((x) => !/^\d{1,30}$/.test(x))) throw new OpError(400, 'validation', `Scegli al massimo ${MAX_SELECTED} case simili.`);
  const all = (await db.prepare('SELECT listing_id FROM market_comps WHERE house_id = ?').bind(house.id).all()).results || [];
  if (ids.some((x) => !all.some((r) => r.listing_id === x))) throw new OpError(400, 'validation', 'Casa simile non trovata: rifai la ricerca.');
  if (!all.length) return { unchanged: true };
  const at = nowIso();
  await db.batch([
    db.prepare(`UPDATE market_comps SET selected = CASE WHEN listing_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END, updated_at = ?, rev = ${REV_NEXT} WHERE house_id = ?`)
      .bind(JSON.stringify(ids), at, house.id),
    db.prepare(`INSERT INTO audit_log (at, user_email, entity, entity_id, action, changes) VALUES (?, ?, 'house', ?, 'mercato', ?)`)
      .bind(at, user.email, house.id, JSON.stringify({ case_simili: ids.length })),
    db.prepare('INSERT INTO ops (op_id, at, user_email, result) VALUES (?, ?, ?, ?)').bind(opId, at, user.email, JSON.stringify({ selected: ids.length })),
    db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'"),
  ]);
  return { selected: ids.length };
}

registerOps({ 'market.select': marketSelect });

export { checkMarketSettings };
