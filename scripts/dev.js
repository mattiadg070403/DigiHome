// Server locale per provare il gestionale sul computer, senza Cloudflare.
// Uso: node scripts/dev.js  →  http://localhost:8787
// Database in memoria con dati di prova. Accesso in modalità sviluppo (solo localhost).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { FakeD1, freshDb } from '../test/d1.js';
import worker from '../src/worker.js';
import publicCalendar from '../src/public-calendar.js';
import publicGuests from '../src/public-guests.js';
import { loadDemo, DEMO_PLACES } from '../src/demo.js';

const PORT = Number(process.env.PORT || 8787);
const ROOT = new URL('../public/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

const db = freshDb();
void FakeD1;
const admin = { id: crypto.randomUUID(), email: process.env.DEV_EMAIL || 'mattia@example.invalid' };
db.sqlite.prepare("INSERT INTO users (id, email, name, role, active, created_at) VALUES (?, ?, 'Mattia (prova)', 'admin', 1, ?)")
  .run(admin.id, admin.email, new Date().toISOString());
db.sqlite.prepare("INSERT INTO users (id, email, name, role, active, created_at) VALUES (?, 'giulia@example.invalid', 'Giulia (prova)', 'collaboratore', 1, ?)")
  .run(crypto.randomUUID(), new Date().toISOString());
if (!process.env.EMPTY) await loadDemo(db, admin);

function assetsFrom(root) {
  return { async fetch(request) {
    const url = new URL(request.url);
    const file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) return new Response('Non trovato', { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' } });
    } catch {
      return new Response('Non trovato', { status: 404 });
    }
  } };
}

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) return new Response('Non trovato', { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, { headers: { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' } });
    } catch {
      return new Response('Non trovato', { status: 404 });
    }
  },
};

// Calendari finti di Airbnb e Booking per provare l'aggiornamento automatico senza rete.
// Basta collegare un link qualsiasi di airbnb.it / booking.com nelle impostazioni.
const realFetch = globalThis.fetch;
const day = (n) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10).replaceAll('-', ''); };
globalThis.fetch = async (url, opts) => {
  const host = new URL(String(url)).hostname;
  if (/airbnb\./.test(host) || /booking\.com$/.test(host)) {
    const isAirbnb = /airbnb\./.test(host);
    const events = isAirbnb
      ? [['dev-a1@airbnb.com', 30, 34, 'Reserved', 'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMDEV12345'],
        ['dev-blk@airbnb.com', 60, 70, 'Airbnb (Not available)', '']]
      : [['dev-b1@booking.com', 40, 43, 'CLOSED - Not available', '']];
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap(([uid, a, b, sum, desc]) => ['BEGIN:VEVENT',
      `DTSTART;VALUE=DATE:${day(a)}`, `DTEND;VALUE=DATE:${day(b)}`, `UID:${uid}`, `SUMMARY:${sum}`, ...(desc ? [`DESCRIPTION:${desc}`] : []), 'END:VEVENT']),
    'END:VCALENDAR'].join('\r\n');
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/calendar' } });
  }
  // Portale Alloggiati Web finto (nessuna schedina vera parte mai dal server locale).
  if (host === 'alloggiatiweb.poliziadistato.it') return fakeAlloggiati(opts);
  // Apify finto: case simili e prezzi inventati (nessuna richiesta vera parte dal server locale).
  if (host === 'api.apify.com') return fakeApify(String(url), opts);
  return realFetch(url, opts);
};

// Apify finto. Ricerca: 40 annunci inventati intorno a Gallipoli; prezzi: per ogni annuncio e settimana un prezzo
// (più alto ad agosto) oppure "non disponibile" (più spesso ad agosto e vicino alla data).
const apifyRuns = new Map();
const AMEN = [['Air conditioning'], ['Wifi'], ['Free parking on premises'], ['Patio or balcony'], ['Sea view'], ['Washer'], ['Dishwasher'], ['Outdoor shower'], ['TV'], ['Pool']];
function fakeListing(i) {
  const seed = (n) => ((i * 9301 + n * 49297) % 233280) / 233280;
  const cap = 2 + Math.floor(seed(1) * 9);
  return {
    id: String(5000000 + i), url: `https://www.airbnb.com/rooms/${5000000 + i}`, title: `Casa di prova ${i + 1} a Gallipoli`,
    personCapacity: cap, coordinates: { latitude: 40.0558 + (seed(2) - 0.5) * 0.05, longitude: 17.9925 + (seed(3) - 0.5) * 0.05 },
    rating: { guestSatisfaction: 4.3 + seed(4) * 0.7, reviewsCount: Math.floor(seed(5) * 120) },
    subDescription: { items: [`${cap} guests`, `${Math.max(1, Math.round(cap / 2.5))} bedrooms`, `${cap} beds`, '1 bath'] },
    amenities: [{ title: 'Servizi', values: AMEN.filter((_, k) => seed(10 + k) > 0.35).map(([t]) => ({ title: t, available: true })) }],
  };
}
function fakeApify(url, opts) {
  const u = new URL(url);
  const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let m = /^\/v2\/acts\/([^/]+)\/runs$/.exec(u.pathname);
  if (m && opts.method === 'POST') {
    const id = `run-${apifyRuns.size + 1}`;
    apifyRuns.set(id, { actor: m[1], input: JSON.parse(opts.body) });
    return ok({ data: { id, defaultDatasetId: `ds-${id}`, status: 'RUNNING' } });
  }
  m = /^\/v2\/actor-runs\/([^/]+)$/.exec(u.pathname);
  if (m) return ok({ data: { id: m[1], status: 'SUCCEEDED', defaultDatasetId: `ds-${m[1]}` } });
  m = /^\/v2\/datasets\/ds-([^/]+)\/items$/.exec(u.pathname);
  if (m) {
    const run = apifyRuns.get(m[1]);
    if (!run) return ok([]);
    if (run.actor.endsWith('airbnb-scraper')) return ok(Array.from({ length: 40 }, (_, i) => fakeListing(i)));
    const ws = run.input.checkIn;
    const month = Number(ws.slice(5, 7));
    return ok(run.input.startUrls.map(({ url: lu }) => {
      const i = Number(/rooms\/(\d+)/.exec(lu)[1]) - 5000000;
      const item = fakeListing(i);
      const r = ((i * 7 + Number(ws.slice(8)) * 13 + month * 31) % 100) / 100;
      const busy = month === 8 ? 0.75 : month === 7 ? 0.55 : 0.3;
      if (r < busy) return { ...item, price: null };
      const night = Math.round((month === 8 ? 260 : month === 7 ? 210 : 150) * (0.8 + item.personCapacity / 15) * (0.85 + r * 0.3));
      const cleaning = i % 3 ? 60 : 0;
      return { ...item, price: { label: `€${night} night`, amount: `€${night}`, breakDown: {
        basePrice: { description: '7 nights', price: `€${(night * 7).toLocaleString('en-US')}` },
        ...(cleaning ? { cleaningFee: { description: 'Cleaning fee', price: `€${cleaning}` } } : {}),
        serviceFee: { description: 'Airbnb service fee', price: '€0' },
        totalBeforeTaxes: { description: 'Total before taxes', price: `€${(night * 7 + cleaning).toLocaleString('en-US')}` } } } };
    }));
  }
  return new Response('{}', { status: 404 });
}

function fakeAlloggiati(opts) {
  const method = /AlloggiatiService\/(\w+)/.exec(opts.headers.SOAPAction)[1];
  const ok = '<esito>true</esito>';
  const wrap = (inner) => new Response(`<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response xmlns="AlloggiatiService">${inner}</${method}Response></soap:Body></soap:Envelope>`);
  if (/<all:Password>sbagliata</.test(opts.body)) return wrap('<GenerateTokenResult /><result><esito>false</esito><ErroreCod>100</ErroreCod><ErroreDes>Utente o password errati (prova)</ErroreDes></result>');
  if (method === 'GenerateToken') return wrap(`<GenerateTokenResult><token>TOKEN-DI-PROVA</token></GenerateTokenResult><result>${ok}</result>`);
  if (method === 'Authentication_Test') return wrap(`<Authentication_TestResult>${ok}</Authentication_TestResult>`);
  if (method === 'Tabella') {
    const luoghi = /<all:tipo>Luoghi</.test(opts.body);
    const rows = luoghi
      ? ['Codice;Descrizione;Provincia;DataFineVal', ...DEMO_PLACES.map(([c, n, pr]) => `${c};${n};${pr || 'ES'};`),
        ...Array.from({ length: 120 }, (_, i) => `4990${String(i).padStart(5, '0')};COMUNE DI PROVA ${i + 1};TO;`)]
      : ['Codice;Descrizione', 'IDENT;CARTA DI IDENTITA', 'IDELE;CARTA IDENTITA ELETTRONICA', 'PASOR;PASSAPORTO ORDINARIO', 'PATEN;PATENTE DI GUIDA'];
    return wrap(`<TabellaResult>${ok}</TabellaResult><CSV>${rows.join('\r\n')}</CSV>`);
  }
  if (method === 'Test' || method === 'Send') {
    const n = (opts.body.match(/<all:string>/g) || []).length;
    return wrap(`<${method}Result>${ok}</${method}Result><result><SchedineValide>${n}</SchedineValide><Dettaglio>${`<EsitoOperazioneServizio>${ok}</EsitoOperazioneServizio>`.repeat(n)}</Dettaglio></result>`);
  }
  if (method === 'Ricevuta') return wrap(`<RicevutaResult>${ok}</RicevutaResult><PDF>${Buffer.from('%PDF-1.4\n% ricevuta di prova (server locale)\n').toString('base64')}</PDF>`);
  return new Response('?', { status: 500 });
}

const env = {
  // Chiave delle credenziali solo per il server locale (in Cloudflare è un segreto vero).
  CHIAVE_CREDENZIALI: 'chiave-del-server-locale-solo-per-prove-0123456789',
  // Chiave finta di Apify (le richieste vanno all'Apify finto qui sopra).
  APIFY_TOKEN: 'apify_api_server_locale_solo_prove_000000',
  DB: db, ASSETS, CALENDAR_PUBLIC_URL: `http://localhost:${PORT}`, OSPITI_PUBLIC_URL: `http://localhost:${Number(PORT) + 1}`, AUTH_MODE: 'dev', DEV_EMAIL: process.env.AS || admin.email, ALLOW_DEMO: 'true', APP_ENV: 'prova',
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  if (process.env.DELAY_MS && req.url.startsWith('/api/')) await new Promise((r) => setTimeout(r, Number(process.env.DELAY_MS)));
  // Il calendario pubblico (in Cloudflare è un Worker a parte) risponde su /cal/.
  const response = req.url.startsWith('/cal/') ? await publicCalendar.fetch(request, env) : await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`Gestionale di prova su http://localhost:${PORT}`));

// Modulo online per gli ospiti (in Cloudflare è un Worker pubblico a parte): porta successiva.
const guestEnv = { DB: db, ASSETS: assetsFrom(normalize(join(ROOT, '..', 'public-ospiti'))) };
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(`http://localhost:${Number(PORT) + 1}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const response = await publicGuests.fetch(request, guestEnv);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(PORT) + 1, () => console.log(`Modulo per gli ospiti su http://localhost:${Number(PORT) + 1}`));
