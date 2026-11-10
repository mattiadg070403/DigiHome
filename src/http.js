// Risposte HTTP e intestazioni di sicurezza.

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types app',
  'upgrade-insecure-requests',
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

/** Aggiunge le intestazioni di sicurezza a qualsiasi risposta. */
export function secure(response, { cache } = {}) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  if (cache) r.headers.set('Cache-Control', cache);
  return r;
}

export function json(data, status = 200) {
  const opts = typeof status === 'object' ? status : { status };
  return secure(new Response(JSON.stringify(data), {
    status: opts.status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(opts.headers || {}) },
  }), { cache: 'no-store' });
}

export function fail(status, code, message, extra = {}) {
  return json({ ok: false, code, message, ...extra }, status);
}

export function text(body, status = 200) {
  return secure(new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  }), { cache: 'no-store' });
}
