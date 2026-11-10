// Punto di ingresso: accesso, API e file dell'app.

import { authenticate } from './auth.js';
import { fail, json, secure, text } from './http.js';
import { OpError, runOp } from './ops.js';
import { readExport, readHistory, readState } from './state.js';
import { loadDemo } from './demo.js';
import { syncAll } from './calendars.js';
import { APP_VERSION } from '../public/shared/version.js';

export { APP_VERSION };
const MAX_BODY = 64 * 1024;

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return origin === url.origin;
}

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('application/json')) throw new OpError(415, 'type', 'Formato non valido.');
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new OpError(413, 'size', 'Richiesta troppo grande.');
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new OpError(413, 'size', 'Richiesta troppo grande.');
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
      const info = { demo: env.ALLOW_DEMO === 'true', env: env.APP_ENV || 'prova', version: APP_VERSION };
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
    return fail(404, 'not_found', 'Indirizzo sconosciuto.');
  }

  if (request.method === 'POST') {
    if (!sameOrigin(request, url)) return fail(403, 'origin', 'Richiesta non consentita.');
    try {
      if (path === '/api/ops') {
        const body = await readJson(request);
        return json(await runOp(env.DB, user, body));
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
  },
};
