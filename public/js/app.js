// Avvio dell'app: menu, percorsi, indicatore di salvataggio, messaggi.

import { h, icon } from './dom.js';
import { createStore } from './store.js';
import { APP_VERSION } from '../shared/version.js';
import { timeRome, todayRome } from '../shared/dates.js';
import { checkinOverdue, extrasOf } from '../shared/booking.js';
import { renderToday } from './views/today.js';
import { renderBookings } from './views/bookings.js';
import { renderDetail, renderFlow } from './views/detail.js';
import { renderSettings } from './views/settings.js';
import { renderArchive } from './views/archive.js';

const REFRESH_MS = 30000;

// Ricaricare apposta (Accedi, Aggiorna, Riprova) non deve far comparire la domanda "Vuoi uscire?".
let leavingOnPurpose = false;
function reloadApp() {
  leavingOnPurpose = true;
  location.reload();
}

function readPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* preferenza non salvata: nessun problema */ }
}

const store = createStore();

const ui = {
  route: { name: 'today', params: {} },
  houseId: readPref('gc.house', 'isola-bella'),
  bookingsView: readPref('gc.bview', 'elenco'),
  calMonth: null,
  season: null,
  drafts: {},
  history: {},
  today: todayRome(),
  now: timeRome(),
};

/* ---------------------------- Percorsi ---------------------------- */

function parseRoute() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'oggi').split('/').map(decodeURIComponent);
  if (parts[0] === 'prenotazioni') return { name: 'bookings', params: {} };
  if (parts[0] === 'impostazioni') return { name: 'settings', params: {} };
  if (parts[0] === 'archivio') return { name: 'archive', params: { tab: parts[1] || null, house: parts[2] || null } };
  if (parts[0] === 'p' && parts[1]) {
    if (parts[2] === 'checkin' || parts[2] === 'checkout') return { name: 'flow', params: { id: parts[1], flow: parts[2] } };
    return { name: 'detail', params: { id: parts[1] } };
  }
  return { name: 'today', params: {} };
}

function go(path) {
  const target = `#/${path}`;
  if (location.hash === target) render();
  else location.hash = target;
}

function setHouse(id, { silent = false } = {}) {
  ui.houseId = id;
  writePref('gc.house', id);
  ui.season = null;
  if (!silent) render();
}

/* ---------------------------- Messaggi ---------------------------- */

let toastEl = null;
let toastTimer = null;

function toast(message, { undo, bad = false, ms } = {}) {
  clearTimeout(toastTimer);
  if (toastEl) toastEl.remove();
  const close = () => { clearTimeout(toastTimer); if (toastEl) { toastEl.remove(); toastEl = null; } };
  toastEl = h('div', { class: ['toast', bad && 'bad'], attrs: { role: bad ? 'alert' : 'status' } },
    h('span', { text: message }),
    undo ? h('button', { type: 'button', text: 'Annulla', onClick: () => { close(); undo(); } }) : null,
    h('button', { type: 'button', class: 'x', attrs: { 'aria-label': 'Chiudi messaggio' }, onClick: close }, icon('close', { size: 16 })));
  document.body.append(toastEl);
  toastTimer = setTimeout(close, ms || (bad ? 9000 : undo ? 7000 : 3500));
}

/**
 * Esegue una modifica. Se il server la rifiuta, mostra il motivo.
 * `undo` (facoltativo): funzione che costruisce l'operazione inversa per il pulsante "Annulla".
 */
async function act(type, payload, { optimistic, message, undo, quiet = false } = {}) {
  try {
    const res = await store.mutate(type, payload, { optimistic });
    if (message && !quiet) toast(message, { undo: undo ? () => undo(res) : undefined });
    return res;
  } catch (e) {
    toast(e.message || 'Modifica non salvata.', { bad: true });
    throw e;
  }
}

/* ---------------------------- Indicatore ---------------------------- */

// Indicatori presenti sulla pagina: si aggiornano da soli, senza ridisegnare il resto.
const chips = new Set();

function syncChip() {
  const chip = buildChip();
  chips.add(chip);
  return chip;
}

function refreshChips() {
  // Si scorre una copia: aggiungere elementi a un insieme mentre lo si scorre non finirebbe mai.
  for (const old of [...chips]) {
    if (!old.isConnected) { chips.delete(old); continue; }
    const fresh = buildChip();
    old.replaceWith(fresh);
    chips.delete(old);
    chips.add(fresh);
  }
}

function buildChip() {
  const s = store.status;
  const labels = {
    loading: 'Caricamento…',
    saving: s.message || 'Salvataggio…',
    saved: 'Tutto salvato',
    offline: 'Senza connessione',
    'offline-start': 'Senza connessione',
    error: s.message || 'Modifica non salvata',
    auth: 'Sessione scaduta',
  };
  const state = s.state === 'offline-start' ? 'offline' : s.state;
  const chip = h('div', { class: 'sync', dataset: { state }, attrs: { role: 'status', 'aria-live': 'polite' } },
    state === 'saved' ? icon('check', { size: 16 }) : h('span', { class: 'dot' }),
    h('span', { text: labels[s.state] || '' }));
  if (s.state === 'error' || s.state === 'offline') chip.append(h('button', { type: 'button', text: 'Riprova', onClick: () => store.retry() }));
  if (s.state === 'auth') chip.append(h('button', { type: 'button', text: 'Accedi', onClick: reloadApp }));
  return chip;
}

/* ---------------------------- Struttura ---------------------------- */

const NAV = [
  { name: 'today', path: 'oggi', label: 'Oggi', icon: 'home' },
  { name: 'bookings', path: 'prenotazioni', label: 'Prenotazioni', icon: 'calendar' },
  { name: 'archive', path: 'archivio', label: 'Archivio', icon: 'folder' },
  { name: 'settings', path: 'impostazioni', label: 'Impostazioni', icon: 'user' },
];

let shell = null;

function buildShell() {
  const navBtns = (cls) => NAV.map((n) => h('a', {
    class: cls, href: `#/${n.path}`, dataset: { nav: n.name },
  }, icon(n.icon, { size: 20 }), h('span', { text: n.label })));
  const view = h('div', { class: 'page', id: 'view' });
  const brandSub = h('div', { class: 'brand-sub' });
  const envBadge = h('span', { class: 'env-badge', hidden: true });
  const versionLine = h('span', { text: `Versione ${APP_VERSION}` });
  const side = h('nav', { class: 'side', attrs: { 'aria-label': 'Sezioni' } },
    h('div', { class: 'brand' }, h('div', { class: 'brand-title', text: 'DigiHome' }), brandSub),
    navBtns('nav-btn'),
    h('div', { class: 'side-foot' }, envBadge, versionLine));
  const tabbar = h('nav', { class: 'tabbar', attrs: { 'aria-label': 'Sezioni' } }, navBtns('nav-btn'));
  const updateBar = h('div', { class: 'banner warn', hidden: true, attrs: { role: 'status' } },
    h('span', { text: 'È disponibile una nuova versione di DigiHome.' }),
    h('button', { class: 'btn small', type: 'button', text: 'Aggiorna', onClick: reloadApp }));
  const main = h('main', { class: 'main', id: 'main' }, h('div', { class: 'page' }, updateBar), view);
  const root = h('div', { class: 'shell' }, side, main, tabbar);
  document.getElementById('app').replaceChildren(root);
  shell = { view, envBadge, updateBar, brandSub };
}

function updateShell() {
  const current = ui.route.name === 'detail' || ui.route.name === 'flow' ? 'bookings' : ui.route.name;
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  shell.brandSub.textContent = (store.data.houses || []).map((x) => x.name).join(' · ');
  const info = store.info;
  if (info.env && info.env !== 'produzione') {
    shell.envBadge.hidden = false;
    shell.envBadge.textContent = info.demo ? 'PROVA · dati inventati' : `Ambiente: ${info.env}`;
  }
  shell.updateBar.hidden = !(info.version && info.version !== APP_VERSION);
}

/* ---------------------------- Disegno ---------------------------- */

/** Ora attuale e casa della prenotazione: servono per la scadenza delle 24 ore del check-in. */
function clock(b) {
  return { time: ui.now, house: store.data.houses.find((x) => x.id === b.house_id) || {}, extras: extrasOf(b, store.data.extras) };
}

/** Prenotazioni oltre le 24 ore senza check-in concluso (per ridisegnare appena scatta la scadenza). */
function overdueKey() {
  const today = todayRome();
  const time = timeRome();
  return today + (store.data.bookings || [])
    .filter((b) => checkinOverdue(b, today, { time, house: store.data.houses.find((x) => x.id === b.house_id) || {} }))
    .map((b) => b.id).sort().join(',');
}

const ctx = { store, ui, go, setHouse, toast, act, syncChip, clock, render: () => render() };

/** Ricorda il campo in cui si sta scrivendo, per rimetterlo a posto dopo il ridisegno. */
function captureFocus() {
  const el = document.activeElement;
  if (!el || !shell.view.contains(el) || !el.dataset.key) return null;
  return { key: el.dataset.key, start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(f) {
  if (!f) return;
  const el = shell.view.querySelector(`[data-key="${CSS.escape(f.key)}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  try { if (typeof f.start === 'number') el.setSelectionRange(f.start, f.end); } catch { /* campo senza selezione */ }
}

function render() {
  if (!shell) return;
  ui.today = todayRome();
  ui.now = timeRome();
  ui.route = parseRoute();
  updateShell();
  const d = store.data;
  if (!d.me) {
    const s = store.status;
    const msg = s.state === 'auth' ? s.message
      : s.state === 'offline-start' ? 'Connessione assente. Il gestionale riproverà da solo.'
        : 'Caricamento…';
    shell.view.replaceChildren(h('div', { class: 'loading-screen' }, h('p', { text: msg }),
      s.state === 'auth' || s.state === 'offline-start' ? h('button', { class: 'btn', type: 'button', text: s.state === 'auth' ? 'Accedi' : 'Riprova', onClick: reloadApp }) : null));
    return;
  }
  if (!d.houses.some((x) => x.id === ui.houseId) && d.houses[0]) ui.houseId = d.houses[0].id;
  const focus = captureFocus();
  chips.clear();
  let node;
  switch (ui.route.name) {
    case 'bookings': node = renderBookings(ctx); break;
    case 'detail': node = renderDetail(ctx, ui.route.params.id); break;
    case 'flow': node = renderFlow(ctx, ui.route.params.id, ui.route.params.flow); break;
    case 'settings': node = renderSettings(ctx); break;
    case 'archive': node = renderArchive(ctx); break;
    default: node = renderToday(ctx);
  }
  shell.view.replaceChildren(node);
  restoreFocus(focus);
}

/* ---------------------------- Avvio ---------------------------- */

let lastRoute = '';
window.addEventListener('hashchange', () => {
  render();
  if (location.hash !== lastRoute) { window.scrollTo(0, 0); lastRoute = location.hash; }
});

let renderQueued = false;
let lastStatus = store.status.state;
store.subscribe((kind) => {
  if (kind === 'status' || kind === 'info') {
    // Solo l'indicatore e la barra "nuova versione"; la pagina si ridisegna solo se cambia lo stato
    // di accesso o se i dati non sono ancora arrivati.
    refreshChips();
    if (shell) updateShell();
    const st = store.status.state;
    const needsPage = !store.data.me || st === 'auth' || lastStatus === 'auth';
    lastStatus = st;
    if (!needsPage) return;
  }
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
});

// Aggiornamento dei dati: al ritorno sull'app, quando torna la connessione, e ogni 30 secondi.
// Non azzera mai la schermata: aggiorna i dati e ridisegna mantenendo campi, posizione e finestre aperte.
// Se una modifica è ferma per la rete, si riprova da sola appena possibile.
const tryAgainIfStuck = () => { if (store.status.state === 'error' && navigator.onLine !== false) store.retry(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { tryAgainIfStuck(); store.load(); } });
window.addEventListener('online', () => store.retry());
window.addEventListener('pageshow', (e) => { if (e.persisted) store.load(); });
setInterval(() => { if (document.visibilityState === 'visible') { tryAgainIfStuck(); store.load(); } }, REFRESH_MS);
// Chiudere la pagina con modifiche non ancora inviate: il browser chiede conferma (restano comunque sul dispositivo).
window.addEventListener('beforeunload', (e) => { if (store.pending && !leavingOnPurpose) { e.preventDefault(); e.returnValue = ''; } });
// Ogni minuto: ridisegna se cambia il giorno o se un check-in supera le 24 ore dall'arrivo.
let lastOverdue = '';
setInterval(() => {
  const key = overdueKey();
  if (todayRome() !== ui.today || key !== lastOverdue) { lastOverdue = key; render(); }
}, 60000);

// Errori imprevisti dell'app: si registrano anche sul server (senza dati personali), per poterli correggere.
let reported = 0;
function reportError(kind, err) {
  console.error('Errore app', err);
  if (reported >= 5) return;
  reported += 1;
  const message = String((err && (err.message || err.reason)) || err || '').slice(0, 300);
  const stack = String((err && err.stack) || '').slice(0, 1500);
  store.request('/api/log', { method: 'POST', body: { kind, message, stack, route: ui.route.name, version: APP_VERSION } }).catch(() => {});
}
window.addEventListener('error', (e) => reportError('error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => { if (!(e.reason && e.reason.status !== undefined)) reportError('promise', e.reason); });

buildShell();
lastRoute = location.hash;
render();
store.load({ force: true }).then(() => {
  const n = store.resume();
  if (n) toast(`${n === 1 ? 'Una modifica rimasta in sospeso viene salvata ora' : `${n} modifiche rimaste in sospeso vengono salvate ora`}.`);
});
