// Accesso: verifica del token di Cloudflare Access e utente attivo nel database.

const enc = new TextEncoder();
let certCache = { url: null, at: 0, keys: [] };
const CERT_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function getKeys(teamDomain, fetchImpl, force = false) {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const fresh = certCache.url === url && Date.now() - certCache.at < CERT_TTL_MS;
  if (fresh && !force) return certCache.keys;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error('certs');
  const body = await res.json();
  certCache = { url, at: Date.now(), keys: Array.isArray(body.keys) ? body.keys : [] };
  return certCache.keys;
}

/** Verifica un token di Access. Restituisce l'email o lancia un errore. */
export async function verifyAccessJwt(token, { teamDomain, aud, fetchImpl = fetch, now = Date.now() }) {
  if (typeof token !== 'string') throw new Error('token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('token');
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('alg');

  let keys = await getKeys(teamDomain, fetchImpl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys(teamDomain, fetchImpl, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('kid');

  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('signature');

  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(aud)) throw new Error('aud');
  const nowS = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowS - 30) throw new Error('exp');
  if (typeof payload.nbf === 'number' && payload.nbf > nowS + 30) throw new Error('nbf');
  if (payload.iss !== teamDomain) throw new Error('iss');
  if (typeof payload.email !== 'string' || !payload.email.includes('@')) throw new Error('email');
  return payload.email.toLowerCase();
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Chi sta facendo la richiesta. Restituisce { user } oppure { error, status }.
 * Fallisce in modo chiuso: senza configurazione non entra nessuno.
 */
export async function authenticate(request, env, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  let email = null;

  if (env.AUTH_MODE === 'dev') {
    if (!LOCAL_HOSTS.has(url.hostname)) return { status: 500, error: 'Modalità di sviluppo non consentita fuori da localhost.' };
    email = String(env.DEV_EMAIL || 'demo@example.invalid').toLowerCase();
  } else {
    const teamDomain = env.ACCESS_TEAM_DOMAIN;
    const aud = env.ACCESS_AUD;
    if (!teamDomain || !aud || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) {
      return { status: 500, error: 'Accesso non configurato.' };
    }
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) return { status: 401, error: 'Accesso richiesto.' };
    try {
      email = await verifyAccessJwt(token, { teamDomain, aud, fetchImpl });
    } catch {
      return { status: 401, error: 'Accesso non valido.' };
    }
  }

  let user = await env.DB.prepare('SELECT id, email, name, role, active FROM users WHERE email = ?').bind(email).first();

  // Primo avvio: se non esiste nessun utente, l'email indicata in BOOTSTRAP_ADMIN_EMAIL diventa amministratore.
  if (!user && env.BOOTSTRAP_ADMIN_EMAIL && email === String(env.BOOTSTRAP_ADMIN_EMAIL).toLowerCase()) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (count && count.n === 0) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO users (id, email, name, role, active, created_at, rev)
          SELECT ?, ?, ?, 'admin', 1, ?, (SELECT value FROM meta WHERE key = 'rev') + 1
          WHERE NOT EXISTS (SELECT 1 FROM users)`).bind(id, email, 'Amministratore', now),
        env.DB.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'rev'
          AND EXISTS (SELECT 1 FROM users WHERE id = ? AND rev = (SELECT value FROM meta WHERE key = 'rev') + 1)`).bind(id),
      ]);
      user = await env.DB.prepare('SELECT id, email, name, role, active FROM users WHERE email = ?').bind(email).first();
    }
  }

  if (!user || !user.active) return { status: 403, error: 'Questa email non è autorizzata a usare il gestionale.' };
  return { user };
}

/** Solo per i test. */
export function _resetCertCache() {
  certCache = { url: null, at: 0, keys: [] };
}
