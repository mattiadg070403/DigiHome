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
