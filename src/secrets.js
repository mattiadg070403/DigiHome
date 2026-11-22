// Cifratura delle credenziali (Alloggiati Web) con AES-GCM.
//
// La chiave non sta nel database né nel codice: si ricava dal segreto Cloudflare CHIAVE_CREDENZIALI
// (Workers → digihome → Impostazioni → Variabili e segreti). Senza il segreto le credenziali non si possono
// né salvare né usare. Ogni testo cifrato è legato alla sua casa (dati aggiuntivi autenticati): copiato su
// un'altra riga non si decifra.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const SECRET_NAME = 'CHIAVE_CREDENZIALI';
const MIN_SECRET = 32;

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** true se il segreto è presente e abbastanza lungo. */
export function hasSecret(env) {
  return typeof env[SECRET_NAME] === 'string' && env[SECRET_NAME].length >= MIN_SECRET;
}

async function keyFor(env, purpose) {
  if (!hasSecret(env)) throw new Error('missing_secret');
  const base = await crypto.subtle.importKey('raw', enc.encode(env[SECRET_NAME]), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('digihome-credenziali-v1'), info: enc.encode(purpose) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Cifra un oggetto. Restituisce "v1.<iv>.<testo cifrato>". */
export async function sealJson(env, purpose, value) {
  const key = await keyFor(env, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(purpose) }, key,
    enc.encode(JSON.stringify(value))));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

/** Decifra. Lancia un errore se il testo è stato alterato, appartiene ad altro o il segreto è cambiato. */
export async function openJson(env, purpose, sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('sealed_format');
  const key = await keyFor(env, purpose);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(parts[1]), additionalData: enc.encode(purpose) }, key, unb64(parts[2]));
  return JSON.parse(dec.decode(pt));
}
