import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../public/js/store.js';

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const snapshot = (rev, extra = {}) => ({ ok: true, rev, me: { id: 'u', role: 'admin' }, houses: [], users: [],
  bookings: [], notes: [], tasks: [], version: '0.1.0', env: 'prova', demo: true, ...extra });

function deferred() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  return { p, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('una risposta vecchia arrivata dopo una nuova viene scartata', async () => {
  const slow = deferred();
  const calls = [];
  const store = createStore({
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) return slow.p;
      return reply(snapshot(5, { tasks: [{ id: 't1', rev: 5, title: 'nuovo' }] }));
    },
  });
  const first = store.load({ force: true });
  await store.load({ force: true });
  slow.resolve(reply(snapshot(3, { tasks: [{ id: 't1', rev: 3, title: 'vecchio' }] })));
  await first;
  assert.equal(store.data.rev, 5);
  assert.equal(store.data.tasks[0].title, 'nuovo');
});

test('i dati con contatore più basso di quelli già visti non sovrascrivono', async () => {
  let n = 0;
  const store = createStore({
    fetchImpl: async (url, opts) => {
      if (url === '/api/ops') return reply({ ok: true, record: { id: 't1', rev: 7, title: 'salvato', done: 1 } });
      n += 1;
      return reply(n === 1 ? snapshot(6, { tasks: [{ id: 't1', rev: 6, done: 0 }] }) : snapshot(6, { tasks: [{ id: 't1', rev: 6, done: 0 }] }));
    },
  });
  await store.load({ force: true });
  await store.mutate('task.toggle', { id: 't1', done: true });
  // Un ricaricamento che restituisce ancora il contatore 6 non deve riportare done = 0
  await store.load({ force: true });
  await tick();
  assert.equal(store.data.tasks[0].done, 1);
});

test('modifiche in ordine, una alla volta, ripetute con lo stesso codice se la rete cade', async () => {
  const sent = [];
  let failOnce = true;
  const store = createStore({
    sleep: async () => {},
    fetchImpl: async (url, opts) => {
      if (url !== '/api/ops') return reply(snapshot(1));
      const body = JSON.parse(opts.body);
      sent.push(body);
      if (body.type === 'task.add' && failOnce) { failOnce = false; throw new TypeError('rete'); }
      return reply({ ok: true, record: { id: body.payload.id, rev: sent.length + 10 } });
    },
  });
  await store.load({ force: true });
  const a = store.mutate('task.add', { id: 'a', task: { title: 'A' } });
  const b = store.mutate('task.add', { id: 'b', task: { title: 'B' } });
  await Promise.all([a, b]);
  assert.deepEqual(sent.map((s) => s.payload.id), ['a', 'a', 'b']);
  assert.equal(sent[0].opId, sent[1].opId, 'il secondo tentativo usa lo stesso codice');
  assert.notEqual(sent[1].opId, sent[2].opId);
  assert.equal(store.status.state, 'saved');
});

test('modifica mostrata subito e annullata con messaggio se il server la rifiuta', async () => {
  const store = createStore({
    fetchImpl: async (url) => {
      if (url === '/api/ops') return reply({ ok: false, code: 'conflict', message: 'Modificata da un altro dispositivo' }, 409);
      return reply(snapshot(2, { tasks: [{ id: 't1', rev: 2, done: 0 }] }));
    },
  });
  await store.load({ force: true });
  const seen = [];
  store.subscribe(() => seen.push(store.data.tasks[0]?.done));
  const p = store.mutate('task.toggle', { id: 't1', done: true }, {
    optimistic: (d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === 't1' ? { ...t, done: 1 } : t)) }),
  });
  assert.equal(store.data.tasks[0].done, 1, 'visibile subito');
  await assert.rejects(p, (e) => e.code === 'conflict' && /altro dispositivo/.test(e.message));
  assert.equal(store.data.tasks[0].done, 0, 'tornata com’era');
  assert.ok(seen.includes(1) && seen.at(-1) === 0);
});

test('senza rete la modifica resta in attesa con errore visibile e "Riprova" la completa', async () => {
  let online = false;
  const sent = [];
  const store = createStore({
    sleep: async () => {},
    fetchImpl: async (url, opts) => {
      if (!online) throw new TypeError('offline');
      if (url === '/api/ops') { sent.push(JSON.parse(opts.body)); return reply({ ok: true, record: { id: 'n1', rev: 4 } }); }
      return reply(snapshot(4));
    },
  });
  const p = store.mutate('note.add', { id: 'n1', bookingId: 'b1', text: 'ciao' });
  await tick(); await tick();
  assert.equal(store.status.state, 'error');
  assert.equal(store.pending, 1);
  online = true;
  store.retry();
  await p;
  assert.equal(sent.length, 1);
  assert.equal(store.status.state, 'saved');
});

test('pagina di accesso al posto dei dati: stato "sessione scaduta"', async () => {
  const store = createStore({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html'); } }) });
  await store.load({ force: true });
  assert.equal(store.status.state, 'auth');
});

test('controllo veloce: se il contatore non è cambiato i dati restano gli stessi oggetti', async () => {
  let calls = 0;
  const store = createStore({
    fetchImpl: async (url) => {
      calls += 1;
      if (url.includes('?rev=3')) return reply({ ok: true, unchanged: true, rev: 3, version: '0.1.0' });
      return reply(snapshot(3));
    },
  });
  await store.load();
  const before = store.data;
  const changed = await store.load();
  assert.equal(changed, false);
  assert.equal(store.data, before);
  assert.equal(calls, 2);
});

function memoryStorage(initial = []) {
  let saved = initial;
  return { read: () => saved, write: (list) => { saved = list; }, get saved() { return saved; } };
}

test('modifiche non ancora salvate: restano sul dispositivo e ripartono al riavvio con lo stesso codice', async () => {
  const storage = memoryStorage();
  // Primo avvio: rete assente, la modifica resta in attesa
  const s1 = createStore({ storage, sleep: async () => {}, fetchImpl: async (url) => {
    if (url === '/api/ops') throw new TypeError('offline');
    return reply(snapshot(1));
  } });
  await s1.load({ force: true });
  s1.mutate('task.toggle', { id: 't1', done: true }).catch(() => {});
  await tick(); await tick();
  assert.equal(s1.status.state, 'error');
  assert.equal(storage.saved.length, 1);
  const { opId } = storage.saved[0];
  // L'app si chiude e si riapre: la modifica riparte da sola
  const sent = [];
  const s2 = createStore({ storage, sleep: async () => {}, fetchImpl: async (url, opts) => {
    if (url === '/api/ops') { sent.push(JSON.parse(opts.body)); return reply({ ok: true, record: { id: 't1', rev: 2, done: 1 } }); }
    return reply(snapshot(1, { tasks: [{ id: 't1', rev: 1, done: 0 }] }));
  } });
  await s2.load({ force: true });
  assert.equal(s2.resume(), 1);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opId, opId, 'stesso codice: il server non la esegue due volte');
  assert.equal(storage.saved.length, 0, 'confermata: tolta dal dispositivo');
  assert.equal(s2.status.state, 'saved');
});

test('modifiche rimaste troppo a lungo (oltre 72 ore) non si rimandano', async () => {
  const storage = memoryStorage([{ opId: 'vecchia-operazione-123', type: 'task.toggle', payload: { id: 't1', done: true }, at: Date.now() - 80 * 3600 * 1000 }]);
  const s = createStore({ storage, fetchImpl: async () => reply(snapshot(1)) });
  await s.load({ force: true });
  assert.equal(s.resume(), 0);
  assert.equal(storage.saved.length, 0);
});

test('sessione scaduta durante un salvataggio: la modifica non si perde e riparte dopo l’accesso', async () => {
  const storage = memoryStorage();
  let expired = true;
  const sent = [];
  const store = createStore({ storage, sleep: async () => {}, fetchImpl: async (url, opts) => {
    if (expired) return { ok: false, status: 0, type: 'opaqueredirect', json: async () => { throw new Error('no'); } };
    if (url === '/api/ops') { sent.push(JSON.parse(opts.body)); return reply({ ok: true, record: { id: 't1', rev: 2, done: 1 } }); }
    return reply(snapshot(1));
  } });
  let rejected = false;
  store.mutate('task.toggle', { id: 't1', done: true }).catch(() => { rejected = true; });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(store.status.state, 'auth');
  assert.equal(rejected, false, 'non è stata scartata');
  assert.equal(storage.saved.length, 1);
  expired = false;
  store.retry();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sent.length, 1);
  assert.equal(storage.saved.length, 0);
});

test('un record eliminato confermato dal server sparisce subito dall’elenco (niente "ricomparsa")', async () => {
  const store = createStore({ fetchImpl: async (url) => {
    if (url === '/api/ops') return reply({ ok: true, record: { id: 'n1', rev: 3, deleted: 1, text: 'x' } });
    return reply(snapshot(2, { notes: [{ id: 'n1', rev: 2, deleted: 0, text: 'x' }] }));
  } });
  await store.load({ force: true });
  const seen = [];
  store.subscribe(() => seen.push(store.data.notes.length));
  await store.mutate('note.delete', { id: 'n1' }, { optimistic: (d) => ({ ...d, notes: [] }) });
  assert.equal(store.data.notes.length, 0);
  assert.ok(!seen.includes(1), 'la nota non è mai ricomparsa');
});
