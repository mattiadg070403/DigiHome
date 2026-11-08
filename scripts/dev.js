// Server locale per provare il gestionale sul computer, senza Cloudflare.
// Uso: node scripts/dev.js  →  http://localhost:8787
// Database in memoria con dati di prova. Accesso in modalità sviluppo (solo localhost).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { FakeD1, freshDb } from '../test/d1.js';
import worker from '../src/worker.js';
import { loadDemo } from '../src/demo.js';

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

const env = {
  DB: db, ASSETS, AUTH_MODE: 'dev', DEV_EMAIL: process.env.AS || admin.email, ALLOW_DEMO: 'true', APP_ENV: 'prova',
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  if (process.env.DELAY_MS && req.url.startsWith('/api/')) await new Promise((r) => setTimeout(r, Number(process.env.DELAY_MS)));
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`Gestionale di prova su http://localhost:${PORT}`));
