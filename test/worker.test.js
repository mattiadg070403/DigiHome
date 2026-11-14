import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import worker from '../src/worker.js';
import { _resetCertCache } from '../src/auth.js';

const TEAM = 'https://prova.cloudflareaccess.com';
const AUD = 'aud-di-prova-123';
const ORIGIN = 'https://gestione.example.invalid';

const enc = new TextEncoder();
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

let keyPair;
let jwk;

async function keys() {
  if (!keyPair) {
    keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    jwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: 'k1' };
  }
}

async function sign(payload, { kid = 'k1', alg = 'RS256', key } = {}) {
  await keys();
  const h = b64url(enc.encode(JSON.stringify({ alg, kid, typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key || keyPair.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

function claims(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], email: 'admin@example.invalid', exp: now + 600, iat: now, iss: TEAM, ...over };
}

const realFetch = globalThis.fetch;
beforeEach(async () => {
  await keys();
  _resetCertCache();
  globalThis.fetch = async (url) => {
    if (String(url) === `${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
    return realFetch(url);
  };
});

async function makeEnv(over = {}) {
  const db = freshDb();
  await addUser(db, { email: 'admin@example.invalid', role: 'admin' });
  await addUser(db, { email: 'collab@example.invalid', role: 'collaboratore' });
  return {
    DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, APP_ENV: 'prova',
    ASSETS: { fetch: async () => new Response('<!doctype html><title>app</title>', { headers: { 'Content-Type': 'text/html' } }) },
    ...over,
  };
}

async function call(env, path, { token, method = 'GET', body, origin = ORIGIN, type = 'application/json', host = ORIGIN } = {}) {
  const headers = {};
  if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  if (body !== undefined) headers['Content-Type'] = type;
  if (origin) headers.Origin = origin;
  return worker.fetch(new Request(`${host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}

test('senza token: 401', async () => {
  const r = await call(await makeEnv(), '/api/state');
  assert.equal(r.status, 401);
});

test('token valido di un utente autorizzato: 200 con dati e senza cache', async () => {
  const env = await makeEnv();
  const r = await call(env, '/api/state', { token: await sign(claims()) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const body = await r.json();
  assert.equal(body.me.role, 'admin');
  assert.equal(body.houses.length, 2);
});

test('token scaduto, destinatario sbagliato, emittente sbagliato, firma falsa: 401', async () => {
  const env = await makeEnv();
  const now = Math.floor(Date.now() / 1000);
  for (const bad of [claims({ exp: now - 3600 }), claims({ aud: ['altro'] }), claims({ iss: 'https://altro.cloudflareaccess.com' })]) {
    const r = await call(env, '/api/state', { token: await sign(bad) });
    assert.equal(r.status, 401);
  }
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const forged = await sign(claims(), { key: other.privateKey });
  assert.equal((await call(env, '/api/state', { token: forged })).status, 401);
  const noneAlg = await sign(claims(), { alg: 'none' });
  assert.equal((await call(env, '/api/state', { token: noneAlg })).status, 401);
  assert.equal((await call(env, '/api/state', { token: 'a.b.c' })).status, 401);
});

test('email valida ma non autorizzata o disattivata: 403', async () => {
  const env = await makeEnv();
  const r = await call(env, '/api/state', { token: await sign(claims({ email: 'sconosciuto@example.invalid' })) });
  assert.equal(r.status, 403);
  env.DB.sqlite.prepare("UPDATE users SET active = 0 WHERE email = 'collab@example.invalid'").run();
  const r2 = await call(env, '/api/state', { token: await sign(claims({ email: 'collab@example.invalid' })) });
  assert.equal(r2.status, 403);
});

test('accesso non configurato: nessuno entra', async () => {
  const env = await makeEnv({ ACCESS_AUD: '' });
  const r = await call(env, '/api/state', { token: await sign(claims()) });
  assert.equal(r.status, 500);
});

test('modalità sviluppo rifiutata fuori da localhost, accettata su localhost', async () => {
  const env = await makeEnv({ AUTH_MODE: 'dev', DEV_EMAIL: 'admin@example.invalid' });
  assert.equal((await call(env, '/api/state')).status, 500);
  const r = await call(env, '/api/state', { host: 'http://localhost:8787', origin: 'http://localhost:8787' });
  assert.equal(r.status, 200);
});

test('scritture: rifiutate da un altro sito o senza JSON', async () => {
  const env = await makeEnv();
  const token = await sign(claims());
  const body = { opId: crypto.randomUUID(), type: 'task.add', payload: { task: { title: 'Prova' } } };
  assert.equal((await call(env, '/api/ops', { token, method: 'POST', body, origin: 'https://cattivo.example' })).status, 403);
  assert.equal((await call(env, '/api/ops', { token, method: 'POST', body, origin: null })).status, 403);
  assert.equal((await call(env, '/api/ops', { token, method: 'POST', body, type: 'text/plain' })).status, 415);
  const ok = await call(env, '/api/ops', { token, method: 'POST', body });
  assert.equal(ok.status, 200);
});

test('errori di validazione arrivano con messaggio e campi', async () => {
  const env = await makeEnv();
  const token = await sign(claims());
  const r = await call(env, '/api/ops', { token, method: 'POST', body: { opId: crypto.randomUUID(), type: 'booking.create',
    payload: { booking: { house_id: 'faro-blu', channel: 'diretto', guest_name: '', guests: 0 } } } });
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.equal(b.ok, false);
  assert.ok(b.errors.guest_name);
  assert.ok(b.errors.guests);
});

test('dati di prova: solo se abilitati e solo per l’amministratore', async () => {
  const off = await makeEnv();
  const t = await sign(claims());
  assert.equal((await call(off, '/api/demo', { token: t, method: 'POST', body: {} })).status, 403);
  const on = await makeEnv({ ALLOW_DEMO: 'true' });
  const tc = await sign(claims({ email: 'collab@example.invalid' }));
  assert.equal((await call(on, '/api/demo', { token: tc, method: 'POST', body: {} })).status, 403);
  assert.equal((await call(on, '/api/demo', { token: t, method: 'POST', body: {} })).status, 200);
  const st = await (await call(on, '/api/state', { token: t })).json();
  assert.equal(st.bookings.length, 9 + 36); // 9 di questi giorni + 36 soggiorni degli ultimi due anni (storico dei preventivi)
  assert.ok(st.bookings.every((b) => b.guest_name.endsWith('(prova)')));
});

test('le pagine dell’app hanno tutte le intestazioni di sicurezza', async () => {
  const r = await call(await makeEnv(), '/');
  const h = r.headers;
  assert.match(h.get('Content-Security-Policy'), /script-src 'self'/);
  assert.match(h.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(h.get('Content-Security-Policy'), /require-trusted-types-for 'script'/);
  assert.doesNotMatch(h.get('Content-Security-Policy'), /unsafe-inline|unsafe-eval/);
  assert.equal(h.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(h.get('X-Frame-Options'), 'DENY');
  assert.equal(h.get('Referrer-Policy'), 'no-referrer');
  assert.match(h.get('Strict-Transport-Security'), /max-age=\d+/);
  assert.match(h.get('X-Robots-Tag'), /noindex/);
});

test('primo avvio: l’email indicata diventa amministratore una volta sola', async () => {
  const db = freshDb();
  const env = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, BOOTSTRAP_ADMIN_EMAIL: 'mattia@example.invalid',
    ASSETS: { fetch: async () => new Response('') } };
  const r = await call(env, '/api/state', { token: await sign(claims({ email: 'mattia@example.invalid' })) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).me.role, 'admin');
  // Con un utente già presente, il primo avvio non si ripete per altre email
  const env2 = { ...env, BOOTSTRAP_ADMIN_EMAIL: 'altro@example.invalid' };
  const r2 = await call(env2, '/api/state', { token: await sign(claims({ email: 'altro@example.invalid' })) });
  assert.equal(r2.status, 403);
});

test('calendari: "Aggiorna ora" solo con accesso e dallo stesso sito; aggiornamento programmato', async () => {
  const env = await makeEnv();
  const t = await sign(claims());
  const url = 'https://www.airbnb.it/calendar/ical/1.ics?s=riservato';
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20991010\r\nDTEND;VALUE=DATE:20991012\r\nUID:w1\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const before = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u) === url ? new Response(ics) : before(u, o));
  try {
    const cal = await env.DB.prepare("SELECT version FROM calendars WHERE id = 'faro-blu:airbnb'").first();
    const up = await call(env, '/api/ops', { token: t, method: 'POST', body: { opId: crypto.randomUUID(), type: 'calendar.update',
      payload: { id: 'faro-blu:airbnb', version: cal.version, import_url: url } } });
    assert.equal(up.status, 200);
    assert.ok(!(await up.text()).includes('riservato'));
    assert.equal((await call(env, '/api/calendars/sync', { method: 'POST', body: {} })).status, 401);
    assert.equal((await call(env, '/api/calendars/sync', { token: t, method: 'POST', body: {}, origin: 'https://cattivo.example' })).status, 403);
    const r = await call(env, '/api/calendars/sync', { token: t, method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).results[0].created, 1);
    // Aggiornamento programmato (cron)
    env.DB.sqlite.prepare('DELETE FROM bookings').run();
    env.DB.sqlite.prepare("UPDATE calendars SET last_sync_at = NULL").run();
    const waits = [];
    await worker.scheduled({ cron: '*/30 * * * *' }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const n = env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
    assert.equal(n, 1);
    const st = await (await call(env, '/api/state', { token: t })).json();
    assert.ok(!JSON.stringify(st).includes('riservato'));
  } finally {
    globalThis.fetch = before;
  }
});

test('copia dei dati: solo l’amministratore, file scaricabile, senza link riservati', async () => {
  const env = await makeEnv();
  env.DB.sqlite.prepare("UPDATE calendars SET import_url = 'https://www.airbnb.it/calendar/ical/9.ics?s=riservato' WHERE id = 'faro-blu:airbnb'").run();
  const tc = await sign(claims({ email: 'collab@example.invalid' }));
  assert.equal((await call(env, '/api/export', { token: tc })).status, 403);
  assert.equal((await call(env, '/api/export', {})).status, 401);
  const r = await call(env, '/api/export', { token: await sign(claims()) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Disposition'), /attachment; filename="digihome-prova-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const text = await r.text();
  assert.ok(!text.includes('riservato'));
  const data = JSON.parse(text);
  assert.equal(data.app, 'DigiHome');
  assert.equal(data.houses.length, 2);
  assert.ok(Array.isArray(data.audit_log));
});

test('contratto: la firma passa solo dal suo indirizzo, che accetta richieste più grandi; altrove resta il limite', async () => {
  const env = await makeEnv();
  const token = await sign(claims());
  const viaOps = await call(env, '/api/ops', { token, method: 'POST', body: { opId: crypto.randomUUID(), type: 'contract.sign', payload: {} } });
  assert.equal(viaOps.status, 400);
  const big = 'x'.repeat(100 * 1024);
  const opsBig = await call(env, '/api/ops', { token, method: 'POST', body: { opId: crypto.randomUUID(), type: 'note.add', payload: { text: big } } });
  assert.equal(opsBig.status, 413);
  // Sul suo indirizzo 100 KB passano il controllo di dimensione (poi la richiesta è rifiutata perché incompleta).
  const c = await call(env, '/api/contracts', { token, method: 'POST', body: { opId: crypto.randomUUID(), payload: { id: crypto.randomUUID(), booking_id: crypto.randomUUID(), accepted: true, pad: big } } });
  assert.equal(c.status, 404);
  const tooBig = await call(env, '/api/contracts', { token, method: 'POST', body: { opId: crypto.randomUUID(), payload: { pad: 'x'.repeat(500 * 1024) } } });
  assert.equal(tooBig.status, 413);
  // Da un altro sito: rifiutata.
  const cross = await call(env, '/api/contracts', { token, method: 'POST', origin: 'https://altro.example.invalid', body: { opId: crypto.randomUUID(), payload: {} } });
  assert.equal(cross.status, 403);
  // Contratto inesistente: 404, non un errore del server.
  assert.equal((await call(env, `/api/contracts/${crypto.randomUUID()}`, { token })).status, 404);
});
