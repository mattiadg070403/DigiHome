// Dati dell'app e sincronizzazione con il server.
//
// Regole (le cause dei bug del vecchio gestionale, risolte):
// - Il server è l'unica fonte di verità; le modifiche valgono quando il server le conferma.
// - Le modifiche partono una alla volta, in ordine. Ognuna ha un codice: se la rete cade,
//   si ripete con lo stesso codice e il server non la esegue due volte.
// - Un aggiornamento dei dati più vecchio di quello che l'app ha già viene scartato.
// - Aggiornare i dati non tocca mai la schermata: chi disegna decide cosa ridisegnare.
// - Gli errori restano visibili finché non si risolvono.
// - Le modifiche non ancora confermate sono copiate sul dispositivo (fino a 72 ore): se l'app si chiude,
//   si ricarica o la sessione scade, al riavvio ripartono con lo stesso codice (il server non le ripete).

const EMPTY = { rev: -1, me: null, houses: [], users: [], bookings: [], notes: [], tasks: [], calendars: [], extras: [], expenses: [], deadlines: [], contracts: [] };
const COLLECTION = { booking: 'bookings', note: 'notes', task: 'tasks', user: 'users', house: 'houses', calendar: 'calendars', extra: 'extras', expense: 'expenses', deadline: 'deadlines', contract: 'contracts' };
const TIMEOUT_MS = 15000;
const RETRIES = [1000, 3000, 8000];
const OUTBOX_KEY = 'dh.outbox';
const OUTBOX_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/** Memoria del dispositivo (localStorage), con ripiego silenzioso se non disponibile. */
const deviceStorage = {
  read() {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
  },
  write(list) {
    try {
      if (list.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
      else localStorage.removeItem(OUTBOX_KEY);
    } catch { /* memoria piena o non disponibile: si continua solo in memoria */ }
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || 'Errore di comunicazione con il server.');
    this.status = status;
    this.code = body?.code || 'network';
    this.body = body || {};
  }
}

const noStorage = { read: () => [], write: () => {} };

export function createStore({ fetchImpl = (...a) => fetch(...a), newId = () => crypto.randomUUID(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
  storage = typeof localStorage === 'undefined' ? noStorage : deviceStorage } = {}) {
  let data = { ...EMPTY };
  let maxSeenRev = -1;
  let loadSeq = 0;
  let appliedSeq = 0;
  let info = { version: null, env: null, demo: false };
  const queue = [];
  let running = false;
  let status = { state: 'loading', message: '', failedOp: null };
  const listeners = new Set();
  let lastSync = 0;
  let staleRetries = 0;

  /** Copia sul dispositivo delle modifiche non ancora confermate (solo i dati da rimandare). */
  function saveOutbox() {
    storage.write(queue.map((op) => ({ opId: op.opId, type: op.type, payload: op.payload, at: op.at })));
  }

  function emit(kind) {
    for (const fn of listeners) fn(kind);
  }

  function setStatus(next) {
    status = { ...status, ...next };
    emit('status');
  }

  async function request(path, { method = 'GET', body } = {}) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetchImpl(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
        // La pagina di accesso di Cloudflare arriva come reindirizzamento: non lo si segue, così si capisce
        // che la sessione è scaduta (invece di scambiarlo per "connessione assente").
        redirect: 'manual',
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch {
      throw new ApiError(0, { code: 'network', message: 'Connessione assente o lenta.' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new ApiError(401, { code: 'auth', message: 'Sessione scaduta: tocca "Accedi" per entrare di nuovo. Le modifiche non salvate restano su questo dispositivo.' });
    }
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      // Una risposta non JSON di solito è la pagina di accesso di Cloudflare: sessione scaduta.
      throw new ApiError(res.status === 200 ? 401 : res.status, { code: 'auth', message: 'Sessione scaduta: ricarica la pagina per accedere di nuovo.' });
    }
    if (!res.ok || !parsed || parsed.ok === false) throw new ApiError(res.status, parsed);
    return parsed;
  }

  /** Inserisce o sostituisce un record ricevuto dal server, se più recente di quello che c'è. */
  function upsert(entity, record) {
    const key = COLLECTION[entity];
    if (!key || !record || !record.id) return;
    const list = data[key];
    const i = list.findIndex((x) => x.id === record.id);
    if (i >= 0 && (list[i].rev ?? -1) > (record.rev ?? -1)) return;
    const next = list.slice();
    // Un record eliminato (note, cose da fare, extra) esce dall'elenco, come quando si ricarica dal server.
    if (record.deleted) { if (i >= 0) next.splice(i, 1); } else if (i >= 0) next[i] = record; else next.push(record);
    if (key === 'bookings') next.sort((a, b) => (a.check_in < b.check_in ? -1 : a.check_in > b.check_in ? 1 : 0));
    data = { ...data, [key]: next };
    if (typeof record.rev === 'number') maxSeenRev = Math.max(maxSeenRev, record.rev);
  }

  /**
   * Ricarica i dati. Le risposte arrivate fuori ordine o più vecchie dei dati già visti
   * vengono scartate. Restituisce true se i dati sono cambiati.
   */
  async function load({ force = false } = {}) {
    const seq = ++loadSeq;
    const known = !force && data.rev >= 0 ? `?rev=${data.rev}` : '';
    let res;
    try {
      res = await request(`/api/state${known}`);
    } catch (e) {
      if (seq === loadSeq) {
        if (e.code === 'auth' || e.status === 401 || e.status === 403) setStatus({ state: 'auth', message: e.message });
        else if (status.state !== 'error') setStatus({ state: data.rev < 0 ? 'offline-start' : 'offline', message: e.message });
      }
      return false;
    }
    info = { version: res.version, env: res.env, demo: Boolean(res.demo), calendarBase: res.calendarBase || null };
    lastSync = now();
    if (seq < appliedSeq) return false;
    appliedSeq = seq;
    if (status.state === 'offline' || status.state === 'offline-start' || status.state === 'loading' || status.state === 'auth') {
      setStatus({ state: queue.length ? 'saving' : 'saved', message: '' });
    }
    if (res.unchanged) { emit('info'); return false; }
    // Con modifiche ancora in viaggio i dati del server non le contengono: si aspetta la fine
    // (la coda ricarica da sola quando ha finito), così le modifiche mostrate non spariscono.
    if (queue.length) return false;
    if (res.rev < maxSeenRev || res.rev < data.rev) {
      // Dati più vecchi di quelli già ricevuti: si scartano e si riprova una volta, con calma.
      if (seq === loadSeq && staleRetries < 1) {
        staleRetries += 1;
        sleep(1500).then(() => load({ force: true }));
      }
      return false;
    }
    staleRetries = 0;
    data = { rev: res.rev, me: res.me, houses: res.houses, users: res.users, bookings: res.bookings, notes: res.notes, tasks: res.tasks, calendars: res.calendars || [], extras: res.extras || [], expenses: res.expenses || [], deadlines: res.deadlines || [], contracts: res.contracts || [] };
    maxSeenRev = Math.max(maxSeenRev, res.rev);
    emit('data');
    return true;
  }

  /**
   * Invia una modifica. `optimistic(data)` può restituire una copia dei dati con la modifica
   * già applicata, per mostrarla subito. Restituisce una promessa con la risposta del server;
   * in caso di errore i dati tornano come prima e la promessa viene rifiutata.
   */
  function mutate(type, payload, { optimistic } = {}) {
    return new Promise((resolve, reject) => {
      const op = { opId: newId(), type, payload, optimistic, resolve, reject, before: null, at: now() };
      queue.push(op);
      saveOutbox();
      if (optimistic) {
        op.before = data;
        const next = optimistic(data);
        if (next) { data = next; emit('data'); }
      }
      setStatus({ state: 'saving', message: '', failedOp: null });
      pump();
    });
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const op = queue[0];
        let result;
        let error;
        for (let attempt = 0; ; attempt++) {
          try {
            result = await request('/api/ops', { method: 'POST', body: { opId: op.opId, type: op.type, payload: op.payload } });
            error = null;
            break;
          } catch (e) {
            error = e;
            const retriable = e.status === 0 || e.status >= 500;
            if (!retriable || attempt >= RETRIES.length) break;
            setStatus({ state: 'saving', message: 'Connessione lenta, riprovo…' });
            await sleep(RETRIES[attempt]);
          }
        }
        if (error && (error.status === 0 || error.status >= 500)) {
          // Rete assente o server non raggiungibile: la modifica resta in attesa, con lo stesso codice.
          setStatus({ state: 'error', message: 'Modifica non ancora salvata: connessione assente.', failedOp: op });
          running = false;
          return;
        }
        if (error && (error.code === 'auth' || error.status === 401)) {
          // Sessione scaduta: la modifica resta in attesa (anche sul dispositivo) e riparte dopo l'accesso.
          setStatus({ state: 'auth', message: error.message, failedOp: op });
          running = false;
          return;
        }
        queue.shift();
        saveOutbox();
        if (error) {
          if (op.optimistic && op.before) restore(op);
          setStatus({ state: queue.length ? 'saving' : 'saved', message: '' });
          op.reject(error);
          // Dopo un conflitto o un rifiuto, ricarica per mostrare i dati veri.
          load({ force: true });
          continue;
        }
        if (result.record) upsert(entityOf(op.type), result.record);
        // Operazioni che cambiano anche la prenotazione (es. contratto eliminato: passaggio del check-in tolto).
        if (result.booking) upsert('booking', result.booking);
        if (op.optimistic) op.before = null;
        emit('data');
        op.resolve(result);
        if (!queue.length) setStatus({ state: 'saved', message: '' });
      }
    } finally {
      running = false;
    }
    // Dopo le modifiche, controlla se nel frattempo altri hanno cambiato qualcosa.
    load();
  }

  /** Riporta indietro una modifica mostrata in anticipo e rifiutata dal server. */
  function restore(op) {
    // Ripristina solo i record toccati, senza cancellare modifiche successive già confermate.
    const key = COLLECTION[entityOf(op.type)];
    const id = op.payload.id || op.payload.bookingId;
    if (key && id) {
      const old = op.before[key].find((x) => x.id === id);
      const list = data[key].filter((x) => x.id !== id);
      if (old) list.push(old);
      if (key === 'bookings') list.sort((a, b) => (a.check_in < b.check_in ? -1 : 1));
      data = { ...data, [key]: list };
    } else {
      data = op.before;
    }
    emit('data');
  }

  /**
   * Al riavvio: rimette in coda le modifiche rimaste sul dispositivo e le invia.
   * Restituisce quante sono.
   */
  function resume() {
    const saved = storage.read();
    const fresh = Array.isArray(saved) ? saved.filter((x) => x && typeof x.opId === 'string' && typeof x.type === 'string'
      && x.payload && typeof x.at === 'number' && now() - x.at < OUTBOX_MAX_AGE_MS) : [];
    const known = new Set(queue.map((op) => op.opId));
    for (const x of fresh) {
      if (known.has(x.opId)) continue;
      queue.push({ opId: x.opId, type: x.type, payload: x.payload, at: x.at, optimistic: null, before: null,
        resolve: () => {}, reject: () => {} });
    }
    saveOutbox();
    if (queue.length) {
      setStatus({ state: 'saving', message: 'Invio delle modifiche rimaste in sospeso…', failedOp: null });
      pump();
    }
    return fresh.length;
  }

  /** Riprova la modifica rimasta in attesa (pulsante "Riprova"). */
  function retry() {
    if (queue.length) {
      setStatus({ state: 'saving', message: '', failedOp: null });
      pump();
    } else load({ force: true });
  }

  /** Aggiunge i record arrivati fuori dalla coda (es. firma del contratto, che si fa solo in linea). */
  function accept(list) {
    for (const [entity, record] of list) upsert(entity, record);
    emit('data');
  }

  return {
    get data() { return data; },
    get status() { return status; },
    get info() { return info; },
    get pending() { return queue.length; },
    get lastSync() { return lastSync; },
    load,
    mutate,
    retry,
    resume,
    request,
    accept,
    newId,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

function entityOf(type) {
  return type.split('.')[0];
}
