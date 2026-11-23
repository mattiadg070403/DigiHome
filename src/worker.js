// Punto di ingresso: accesso, API e file dell'app.

import { authenticate } from './auth.js';
import { fail, json, secure, text } from './http.js';
import { OpError, PRIVATE_OPS, runOp, contractDraft, readContract, purgeContracts } from './ops.js';
import { GUEST_HANDLERS, listGuests, purgeGuests } from './guests.js';
import { checkConnection, docTypes, fetchReceipt, placesStats, readReceipt, receiptJob, saveCredentials, searchPlaces, sendSchedine } from './questura.js';
import { dmsFile } from './dms.js';
import './guest-form.js';
import { hasSecret } from './secrets.js';

/**
 * Indirizzo del modulo per gli ospiti casa per casa (dominio della casa, es. registrazione.faroblugallipoli.it):
 * variabile OSPITI_DOMINI = {"faro-blu":"https://…","isola-bella":"https://…"}. Solo indirizzi https validi.
 */
function formDomains(env) {
  try {
    const map = JSON.parse(env.OSPITI_DOMINI || '{}');
    return Object.fromEntries(Object.entries(map).filter(([k, v]) => /^[a-z0-9-]{2,40}$/.test(k) && /^https:\/\/[a-z0-9.-]+$/.test(String(v))));
  } catch {
    return {};
  }
}
import { readExport, readHistory, readState } from './state.js';
import { loadDemo } from './demo.js';
import { syncAll } from './calendars.js';
import { APP_VERSION } from '../public/shared/version.js';

export { APP_VERSION };
const MAX_BODY = 64 * 1024;
// La firma del contratto porta due immagini: limite più alto solo per quell'indirizzo.
const MAX_BODY_CONTRACT = 400 * 1024;

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return origin === url.origin;
}

async function readJson(request, max = MAX_BODY) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('application/json')) throw new OpError(415, 'type', 'Formato non valido.');
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) throw new OpError(413, 'size', 'Richiesta troppo grande.');
  const raw = await request.text();
  if (raw.length > max) throw new OpError(413, 'size', 'Richiesta troppo grande.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new OpError(400, 'json', 'Richiesta non valida.');
  }
}

async function handleApi(request, env, url) {
  const auth = await authenticate(request, env);
  if (auth.error) return fail(auth.status, 'auth', auth.error);
  const { user } = auth;
  const path = url.pathname;

  if (request.method === 'GET') {
    if (path === '/api/state') {
      const info = { demo: env.ALLOW_DEMO === 'true', env: env.APP_ENV || 'prova', version: APP_VERSION, secretReady: hasSecret(env),
        calendarBase: /^(https:\/\/[a-z0-9.-]+|http:\/\/localhost:\d+)$/.test(env.CALENDAR_PUBLIC_URL || '') ? env.CALENDAR_PUBLIC_URL : null,
        formBase: /^(https:\/\/[a-z0-9.-]+|http:\/\/localhost:\d+)$/.test(env.OSPITI_PUBLIC_URL || '') ? env.OSPITI_PUBLIC_URL : null,
        formBases: formDomains(env) };
      // Controllo veloce: se l'app ha già l'ultima versione dei dati, non li rimanda.
      const known = url.searchParams.get('rev');
      if (known !== null && /^\d{1,12}$/.test(known)) {
        const cur = await env.DB.prepare("SELECT value FROM meta WHERE key = 'rev'").first();
        if (cur && cur.value === Number(known)) return json({ ok: true, unchanged: true, rev: cur.value, ...info });
      }
      const state = await readState(env.DB, user);
      return json({ ok: true, ...state, ...info });
    }
    if (path === '/api/export') {
      if (user.role !== 'admin') return fail(403, 'forbidden', 'Solo l’amministratore può scaricare i dati.');
      const data = await readExport(env.DB);
      const day = new Date().toISOString().slice(0, 10);
      return json({ ok: true, app: 'DigiHome', version: APP_VERSION, env: env.APP_ENV || 'prova', exported_at: new Date().toISOString(), ...data },
        { headers: { 'Content-Disposition': `attachment; filename="digihome-${env.APP_ENV || 'prova'}-${day}.json"` } });
    }
    const m = path.match(/^\/api\/bookings\/([A-Za-z0-9-]{8,64})\/history$/);
    if (m) return json({ ok: true, history: await readHistory(env.DB, m[1]) });
    try {
      // Ospiti della prenotazione: si leggono solo aprendo la scheda (non fanno parte dello stato).
      const g = path.match(/^\/api\/bookings\/([A-Za-z0-9-]{8,64})\/guests$/);
      if (g) return json({ ok: true, guests: await listGuests(env.DB, g[1]) }, { headers: { 'Cache-Control': 'no-store' } });
      if (path === '/api/places') {
        return json({ ok: true, places: await searchPlaces(env.DB, url.searchParams.get('q'), url.searchParams.get('kind')) });
      }
      if (path === '/api/doc-types') return json({ ok: true, docTypes: await docTypes(env.DB) });
      if (path === '/api/places/stats') return json({ ok: true, stats: await placesStats(env.DB) });
      const rc = path.match(/^\/api\/receipts\/([A-Za-z0-9-]{8,64})$/);
      if (rc) {
        const r = await readReceipt(env.DB, rc[1]);
        const bytes = r.pdf instanceof Uint8Array ? r.pdf : new Uint8Array(r.pdf);
        return secure(new Response(bytes, { status: 200, headers: {
          'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename="ricevuta-alloggiati-${r.house_id}-${r.date}.pdf"`,
        } }), { cache: 'no-store' });
      }
      if (path === '/api/dms') {
        const { house, xml } = await dmsFile(env.DB, url.searchParams.get('house'), url.searchParams.get('from'), url.searchParams.get('to'));
        return secure(new Response(xml, { status: 200, headers: {
          'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename="dms-${house.id}-${url.searchParams.get('from')}-${url.searchParams.get('to')}.xml"`,
        } }), { cache: 'no-store' });
      }
      const draft = path.match(/^\/api\/bookings\/([A-Za-z0-9-]{8,64})\/contract-draft$/);
      if (draft) return json({ ok: true, ...(await contractDraft(env.DB, draft[1], url.searchParams.get('lang') || 'it')) });
      const c = path.match(/^\/api\/contracts\/([A-Za-z0-9-]{8,64})$/);
      if (c) return json({ ok: true, contract: await readContract(env.DB, user, c[1]) });
    } catch (e) {
      if (e instanceof OpError) return fail(e.status, e.code, e.message, e.extra);
      throw e;
    }
    return fail(404, 'not_found', 'Indirizzo sconosciuto.');
  }

  if (request.method === 'POST') {
    if (!sameOrigin(request, url)) return fail(403, 'origin', 'Richiesta non consentita.');
    try {
      if (path === '/api/ops') {
        const body = await readJson(request);
        // La firma del contratto non passa dalla coda delle modifiche: si fa solo in linea, dal suo indirizzo.
        // Firme e dati degli ospiti non passano dalla coda delle modifiche: si salvano solo in linea, dai loro indirizzi.
        if (body && PRIVATE_OPS.has(body.type)) return fail(400, 'validation', 'Richiesta non valida.');
        return json(await runOp(env.DB, user, body));
      }
      if (path === '/api/guests') {
        const body = await readJson(request);
        if (!body || !Object.hasOwn(GUEST_HANDLERS, body.type)) return fail(400, 'validation', 'Richiesta non valida.');
        return json(await runOp(env.DB, user, body), { headers: { 'Cache-Control': 'no-store' } });
      }
      if (path === '/api/alloggiati/credentials') {
        const body = await readJson(request);
        return json({ ok: true, result: await saveCredentials(env.DB, env, user, body || {}) });
      }
      if (path === '/api/alloggiati/check') {
        const body = await readJson(request);
        if (user.role !== 'admin') return fail(403, 'forbidden', 'Solo l’amministratore può farlo.');
        return json({ ok: true, result: await checkConnection(env.DB, env, user, { houseId: body && body.houseId, tables: Boolean(body && body.tables) }) });
      }
      if (path === '/api/alloggiati/send') {
        const body = await readJson(request);
        return json({ ok: true, result: await sendSchedine(env.DB, env, user, body || {}) });
      }
      if (path === '/api/alloggiati/receipt') {
        const body = await readJson(request);
        return json({ ok: true, result: await fetchReceipt(env.DB, env, body && body.houseId, body && body.date) });
      }
      if (path === '/api/contracts') {
        const body = await readJson(request, MAX_BODY_CONTRACT);
        return json(await runOp(env.DB, user, { opId: body && body.opId, type: 'contract.sign', payload: body && body.payload }));
      }
      if (path === '/api/log') {
        // Errori imprevisti dell'app: finiscono nei log di Cloudflare (senza email né dati degli ospiti).
        const b = await readJson(request);
        const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
        console.error('Errore app', JSON.stringify({ user: user.id, kind: clip(b.kind, 20), message: clip(b.message, 300),
          stack: clip(b.stack, 1500), route: clip(b.route, 30), version: clip(b.version, 20) }));
        return json({ ok: true });
      }
      if (path === '/api/calendars/sync') {
        // "Aggiorna ora": i calendari aggiornati nell'ultimo minuto non si riscaricano.
        await readJson(request);
        const results = await syncAll(env.DB, { minAgeMs: 60 * 1000 });
        return json({ ok: true, results });
      }
      if (path === '/api/demo') {
        if (env.ALLOW_DEMO !== 'true') return fail(403, 'forbidden', 'Non disponibile in questo ambiente.');
        if (user.role !== 'admin') return fail(403, 'forbidden', 'Solo l’amministratore può farlo.');
        await readJson(request);
        await loadDemo(env.DB, user);
        return json({ ok: true });
      }
    } catch (e) {
      if (e instanceof OpError) return fail(e.status, e.code, e.message, e.extra);
      console.error('Errore operazione', e && e.stack ? e.stack : e);
      return fail(500, 'server', 'Errore del server: la modifica non è stata salvata. Riprova.');
    }
    return fail(404, 'not_found', 'Indirizzo sconosciuto.');
  }

  return fail(405, 'method', 'Metodo non consentito.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      if (request.method !== 'GET' && request.method !== 'HEAD') return text('Metodo non consentito.', 405);
      const res = await env.ASSETS.fetch(request);
      const isApp = /\.(html|js|css|webmanifest)$/.test(url.pathname) || url.pathname === '/';
      return secure(res, { cache: isApp ? 'no-cache' : 'public, max-age=86400' });
    } catch (e) {
      console.error('Errore', e && e.stack ? e.stack : e);
      return url.pathname.startsWith('/api/')
        ? fail(500, 'server', 'Errore del server. Riprova.')
        : text('Errore del server. Riprova tra poco.', 500);
    }
  },

  // Aggiornamento automatico dei calendari di Airbnb e Booking (orari in wrangler.jsonc → triggers).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env.DB).then((r) => {
      const bad = r.filter((x) => !x.ok);
      if (bad.length) console.warn('Calendari non aggiornati', bad.map((x) => `${x.id}: ${x.error}`).join('; '));
    }));
    // Contratti oltre il periodo di conservazione: si cancellano da soli.
    ctx.waitUntil(purgeContracts(env.DB, undefined, 'sistema@digihome.invalid').then((n) => {
      if (n) console.log('Contratti cancellati per fine conservazione', n);
    }).catch((e) => console.error('Cancellazione contratti non riuscita', e && e.stack ? e.stack : e)));
    // Alloggiati Web: ricevute dei giorni di invio (si conservano 5 anni) e dati degli ospiti oltre un anno dalla partenza.
    // Le ricevute si cercano tre volte al giorno (7, 13 e 19, ora italiana): il portale le prepara dal giorno dopo l'invio.
    const romeHour = Number(new Intl.DateTimeFormat('it-IT', { hour: '2-digit', hour12: false, timeZone: 'Europe/Rome' }).format(new Date(event.scheduledTime || Date.now())));
    const romeMinute = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
    const download = [7, 13, 19].includes(romeHour) && romeMinute < 30;
    ctx.waitUntil(receiptJob(env.DB, env, { download }).then((r) => {
      if (r.fetched || r.purged) console.log('Ricevute Alloggiati', JSON.stringify({ scaricate: r.fetched, cancellate: r.purged }));
      if (r.errors.length) console.warn('Ricevute Alloggiati non scaricate', r.errors.join('; '));
    }).catch((e) => console.error('Ricevute Alloggiati', e && e.stack ? e.stack : e)));
    ctx.waitUntil(purgeGuests(env.DB).then((n) => {
      if (n) console.log('Ospiti cancellati (oltre un anno dalla partenza)', n);
    }).catch((e) => console.error('Cancellazione ospiti non riuscita', e && e.stack ? e.stack : e)));
  },
};
