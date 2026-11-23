// Modulo online per gli ospiti (Worker pubblico a parte, senza Cloudflare Access).
//
// Fa UNA sola cosa: la pagina del modulo per un link valido.
//   GET  /<codice di 12 caratteri>      → pagina del modulo (file statici in public-ospiti/)
//   GET  /api/form/<codice>             → casa, date, numero di ospiti (nessun dato personale)
//   GET  /api/form/<codice>/places?q=…  → ricerca di comuni e stati nelle tabelle ufficiali
//   POST /api/form/<codice>             → invio dei dati degli ospiti
// Nient'altro: nessuna pagina del gestionale, nessun dato già salvato. Codice sbagliato → "link non valido".

import { OpError } from './ops.js';
import { formInfo, formPlaces, submitForm } from './guest-form.js';

const CODE = '[1-9A-HJ-NP-Za-km-z]{12}';
const PAGE_RE = new RegExp(`^/(${CODE})$`);
const API_RE = new RegExp(`^/api/form/(${CODE})(/places)?$`);
import { json, fail, secure, text } from './http.js';

const MAX_BODY = 64 * 1024;
const STATIC = new Set(['/form.js', '/form.css', '/favicon.svg']);

async function page(env, path, request) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: 'GET' }));
  return secure(res, { cache: path === '/index.html' ? 'no-store' : 'public, max-age=300' });
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/robots.txt') return text('User-agent: *\nDisallow: /\n');
  if (request.method === 'GET' && STATIC.has(path)) return page(env, path, request);
  const r = PAGE_RE.exec(path);
  if (r && request.method === 'GET') return page(env, '/index.html', request);
  const m = API_RE.exec(path);
  if (!m) return fail(404, 'not_found', 'Pagina non trovata.');
  const token = m[1];
  try {
    if (request.method === 'GET' && !m[2]) return json({ ok: true, form: await formInfo(env.DB, token, undefined, url.searchParams.get('part')) });
    if (request.method === 'GET' && m[2]) {
      return json({ ok: true, places: await formPlaces(env.DB, token, url.searchParams.get('q'), url.searchParams.get('kind')) });
    }
    if (request.method === 'POST' && !m[2]) {
      // Solo dalla pagina stessa: JSON, stessa origine, dimensione limitata.
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return fail(403, 'forbidden', 'Richiesta non consentita.');
      if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return fail(415, 'validation', 'Richiesta non valida.');
      const raw = await request.text();
      if (raw.length > MAX_BODY) return fail(413, 'validation', 'Troppi dati.');
      let body;
      try { body = JSON.parse(raw); } catch { return fail(400, 'validation', 'Richiesta non valida.'); }
      return json(await submitForm(env.DB, token, body));
    }
    return fail(405, 'method', 'Metodo non consentito.');
  } catch (e) {
    if (e instanceof OpError) return fail(e.status, e.code, e.message, e.extra || {});
    console.error('Modulo ospiti', e && e.stack ? e.stack : e);
    return fail(500, 'server', 'Errore del server: riprova tra poco.');
  }
}

export default { fetch: handle };
