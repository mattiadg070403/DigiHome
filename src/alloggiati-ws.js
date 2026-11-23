// Client del servizio web ufficiale di Alloggiati Web (Polizia di Stato).
//
// Indirizzo e metodi dal manuale "Documento di Descrizione WS_ALLOGGIATI" (rev. 01, 2022):
//   GenerateToken(Utente, Password, WsKey) → token temporaneo
//   Authentication_Test(Utente, token)       → controlla l'accesso, non invia niente
//   Test(Utente, token, ElencoSchedine)      → controlla le schedine, non le invia
//   Send(Utente, token, ElencoSchedine)      → invia le schedine (solo quelle corrette vengono accettate)
//   Ricevuta(Utente, token, Data)            → PDF della ricevuta di un giorno (ultimi 30 giorni, oggi escluso)
//   Tabella(Utente, token, tipo)             → tabella ufficiale in CSV con ";" (Luoghi, Tipi_Documento, …)
// SOAP 1.1, spazio dei nomi "AlloggiatiService". Nessuna libreria: l'XML si scrive e si legge a mano.

export const ENDPOINT = 'https://alloggiatiweb.poliziadistato.it/service/service.asmx';
const NS = 'AlloggiatiService';
const TIMEOUT_MS = 25000;

export class WsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function xmlUnescape(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Contenuti di tutti gli elementi con quel nome (senza prefisso, maiuscole indifferenti). */
export function tagAll(xml, ...names) {
  const out = [];
  const alt = names.join('|');
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?(${alt})(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?\\1\\s*>`, 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(m[2]);
  return out;
}

export function tag(xml, ...names) {
  const all = tagAll(xml, ...names);
  return all.length ? xmlUnescape(all[0]).trim() : null;
}

/** Esito di un blocco (EsitoOperazioneServizio): ok, codice e descrizione dell'errore. */
export function esitoOf(xml) {
  const e = tag(xml, 'esito');
  return {
    ok: e !== null && e.toLowerCase() === 'true',
    code: tag(xml, 'errorCod', 'ErroreCod'),
    desc: tag(xml, 'errorDes', 'ErroreDes'),
    detail: tag(xml, 'erroreDettaglio', 'ErroreDettaglio'),
  };
}

export function envelope(method, fields) {
  const body = fields.map(([name, value]) => {
    if (Array.isArray(value)) return `<all:${name}>${value.map((v) => `<all:string>${xmlEscape(v)}</all:string>`).join('')}</all:${name}>`;
    return `<all:${name}>${xmlEscape(value)}</all:${name}>`;
  }).join('');
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:all="${NS}"><soap:Body><all:${method}>${body}</all:${method}></soap:Body></soap:Envelope>`;
}

async function call(fetchImpl, method, fields) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${NS}/${method}"` },
      body: envelope(method, fields),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new WsError('network', ctrl.signal.aborted
      ? 'Il portale Alloggiati non ha risposto in tempo. Riprova tra poco.'
      : 'Non riesco a raggiungere il portale Alloggiati. Riprova tra poco.');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    const fault = tag(text, 'faultstring', 'Text');
    if (res.status === 403) throw new WsError('blocked', 'Il portale Alloggiati ha rifiutato la richiesta (accesso bloccato).');
    throw new WsError('http', `Il portale Alloggiati ha risposto con un errore (${res.status})${fault ? `: ${fault.slice(0, 200)}` : ''}.`);
  }
  if (!/<(?:[A-Za-z0-9_]+:)?Envelope[\s>]/i.test(text)) throw new WsError('format', 'Risposta del portale Alloggiati non riconosciuta.');
  return text;
}

/** Messaggio leggibile per un esito negativo. */
export function esitoText(e) {
  const parts = [e.desc, e.detail].filter(Boolean);
  return parts.length ? parts.join(' – ') : 'errore senza descrizione';
}

/**
 * Client per una casa. cred: { utente, password, wskey }.
 * Il token vive solo in memoria per la durata della richiesta.
 */
export function alloggiatiClient(cred, { fetchImpl = fetch } = {}) {
  let token = null;

  async function getToken() {
    if (token) return token;
    const xml = await call(fetchImpl, 'GenerateToken', [['Utente', cred.utente], ['Password', cred.password], ['WsKey', cred.wskey]]);
    const e = esitoOf(xml);
    const t = tag(xml, 'token');
    if (!e.ok || !t) throw new WsError('auth', `Accesso ad Alloggiati non riuscito: ${esitoText(e)}.`, { esito: e });
    token = t;
    return token;
  }

  async function schedine(method, rows) {
    const t = await getToken();
    const xml = await call(fetchImpl, method, [['Utente', cred.utente], ['token', t], ['ElencoSchedine', rows]]);
    const overall = esitoOf(xml);
    const valid = Number(tag(xml, 'SchedineValide'));
    const dett = tagAll(xml, 'Dettaglio')[0] || '';
    const details = tagAll(dett, 'EsitoOperazioneServizio').map(esitoOf);
    return { ok: overall.ok && valid === rows.length && details.every((d) => d.ok || d.code === null), overall, valid: Number.isFinite(valid) ? valid : 0, details };
  }

  return {
    /** Prova di accesso: token + Authentication_Test. Non invia niente. */
    async check() {
      const t = await getToken();
      const xml = await call(fetchImpl, 'Authentication_Test', [['Utente', cred.utente], ['token', t]]);
      const e = esitoOf(xml);
      if (!e.ok) throw new WsError('auth', `Prova di accesso non riuscita: ${esitoText(e)}.`, { esito: e });
      return true;
    },
    test: (rows) => schedine('Test', rows),
    send: (rows) => schedine('Send', rows),
    /** PDF della ricevuta del giorno (aaaa-mm-gg) o null se per quel giorno non c'è. */
    async receipt(date) {
      const t = await getToken();
      const xml = await call(fetchImpl, 'Ricevuta', [['Utente', cred.utente], ['token', t], ['Data', `${date}T00:00:00`]]);
      const e = esitoOf(xml);
      const pdf = tag(xml, 'PDF');
      if (!e.ok || !pdf) return { pdf: null, esito: e };
      const bin = atob(pdf.replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new WsError('format', 'La ricevuta scaricata non è un PDF.');
      return { pdf: bytes, esito: e };
    },
    /** Tabella ufficiale (CSV con ";"). */
    async table(tipo) {
      const t = await getToken();
      const xml = await call(fetchImpl, 'Tabella', [['Utente', cred.utente], ['token', t], ['tipo', tipo]]);
      const e = esitoOf(xml);
      if (!e.ok) throw new WsError('table', `Tabella ${tipo} non scaricata: ${esitoText(e)}.`);
      // Il CSV è il testo più lungo della risposta.
      const texts = [...xml.matchAll(/>([^<]{20,})</g)].map((m) => xmlUnescape(m[1]));
      const csv = texts.sort((a, b) => b.length - a.length)[0] || '';
      if (!csv.includes(';')) throw new WsError('table', `Tabella ${tipo} vuota o non riconosciuta.`);
      return csv;
    },
  };
}

/* ------------------------------ Tabelle ufficiali ------------------------------ */

/** "31/12/2020", "2020-12-31" o "31/12/2020 00:00:00" → "2020-12-31" (null se non è una data). */
function parseItDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function splitCsv(csv) {
  const lines = csv.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => l.split(';').map((x) => x.trim().replace(/^"(.*)"$/, '$1')));
}

/**
 * Luoghi: comuni italiani e stati. Le colonne si riconoscono dall'intestazione
 * (codice, descrizione, provincia, data di fine validità); un luogo con data di fine è "non attivo".
 * Stati: codice che inizia con 100 (es. Italia 100000100) oppure provincia "ES".
 */
export function parsePlaces(csv) {
  const rows = splitCsv(csv);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.toLowerCase());
  const col = (re, fallback) => { const i = head.findIndex((h) => re.test(h)); return i >= 0 ? i : fallback; };
  const iCode = col(/codice/, 0);
  const iName = col(/descr/, 1);
  const iProv = col(/prov/, 2);
  const iEnd = col(/fine|scad|valid/, -1);
  const out = [];
  for (const r of rows.slice(1)) {
    const code = (r[iCode] || '').replace(/\D/g, '');
    const name = (r[iName] || '').trim();
    if (code.length !== 9 || !name) continue;
    const prov = (r[iProv] || '').trim().toUpperCase().slice(0, 2);
    const state = code.startsWith('100') || prov === 'ES' || !prov;
    // Non più valido solo se c'è una data di fine già passata (date come 31/12/9999 = ancora valido).
    const endIso = parseItDate(iEnd >= 0 ? r[iEnd] : '');
    const active = endIso && endIso < new Date().toISOString().slice(0, 10) ? 0 : 1;
    out.push({ code, name: name.slice(0, 80), province: state ? null : prov, kind: state ? 'S' : 'C', active });
  }
  return out;
}

/** Tipi di documento: codice (fino a 5 caratteri) e descrizione. */
export function parseDocTypes(csv) {
  const rows = splitCsv(csv);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.toLowerCase());
  const iCode = Math.max(0, head.findIndex((h) => /codice/.test(h)));
  const iName = head.findIndex((h) => /descr/.test(h)) >= 0 ? head.findIndex((h) => /descr/.test(h)) : 1;
  return rows.slice(1).map((r) => ({ code: (r[iCode] || '').trim().toUpperCase(), name: (r[iName] || '').trim().slice(0, 80) }))
    .filter((x) => /^[A-Z0-9]{1,5}$/.test(x.code) && x.name);
}
