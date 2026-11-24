// Questura e DMS: impostazioni del collegamento con Alloggiati Web (solo amministratore),
// archivio delle ricevute e riepilogo del DMS Puglia (SPOT Easy).

import { h, icon } from '../dom.js';
import { field, setFieldError, openDialog, confirmDialog, tag } from '../ui.js';
import { dateField } from '../pickers.js';
import { addDays, fmtShort } from '../../shared/dates.js';
import { enteredAfterStay, parseSteps } from '../../shared/booking.js';

const SECRET_NAME = 'CHIAVE_CREDENZIALI';

export function parseStatus(house) {
  try { return house && house.alloggiati_status ? JSON.parse(house.alloggiati_status) : {}; } catch { return {}; }
}
const when = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }) : '');

/** Chiave casuale generata sul dispositivo (non passa dal server): da incollare in Cloudflare. */
function randomKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Riassunto dello stato del collegamento (anche per la riga della casa nelle impostazioni). */
export function alloggiatiSummary(house) {
  const st = parseStatus(house);
  if (!st.configured) return { text: 'Alloggiati Web: invio automatico non impostato', tone: 'neutral' };
  if (st.error) return { text: 'Alloggiati Web: da controllare', tone: 'warn' };
  return { text: 'Alloggiati Web: collegato', tone: 'ok' };
}

export function alloggiatiSettingsDialog(ctx, house) {
  const { store } = ctx;
  const ready = store.info.secretReady;
  const result = h('div', { attrs: { 'aria-live': 'polite' } });
  const statusBox = h('div', { class: 'stack' });
  const drawStatus = (h0) => {
    const st = parseStatus(h0);
    statusBox.replaceChildren(...[
      st.configured
        ? h('div', { class: 'acc-lines' },
          line('Credenziali', `salvate il ${when(st.set_at)} (utente ${st.user_hint || '…'})`),
          line('Ultima prova riuscita', st.ok_at ? when(st.ok_at) : 'mai'),
          line('Tabelle ufficiali (luoghi e documenti)', st.tables_at ? `scaricate il ${when(st.tables_at)}` : 'non ancora scaricate'))
        : h('p', { class: 'muted small', text: 'Credenziali non ancora inserite.' }),
      st.error ? h('div', { class: 'banner bad small', text: `${st.error}${st.error_at ? ` (${when(st.error_at)})` : ''}` }) : null,
      st.receipt_warning ? h('div', { class: 'banner warn small', text: st.receipt_warning }) : null].filter(Boolean));
  };
  const latest = () => store.data.houses.find((x) => x.id === house.id) || house;
  drawStatus(latest());
  // Quanti luoghi ci sono nelle tabelle ufficiali scaricate (per capire subito se qualcosa non va).
  const statsBox = h('p', { class: 'hint' });
  const loadStats = () => store.request('/api/places/stats').then((r) => {
    const s = r.stats || {};
    statsBox.textContent = `Tabelle nel gestionale: ${s.comuni} comuni (più ${s.comuniSoppressi} non più esistenti), ${s.stati} stati, ${s.documenti} tipi di documento.`;
  }).catch(() => { statsBox.textContent = ''; });
  loadStats();

  const show = (r) => {
    if (r.ok) {
      result.replaceChildren(h('div', { class: 'banner ok small', text: `Collegamento riuscito${r.tables ? `: scaricati ${r.tables.places} luoghi e ${r.tables.docs} tipi di documento` : ''}. Nessuna schedina è stata inviata.` }));
    } else result.replaceChildren(h('div', { class: 'banner bad small', text: r.error || 'Collegamento non riuscito.' }));
  };
  const busy = (btn, label, fn) => async () => {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    result.replaceChildren();
    try { await fn(); } catch (e) { result.replaceChildren(h('div', { class: 'banner bad small', text: e.message })); }
    btn.disabled = false;
    btn.textContent = old;
    await store.load({ force: true }).catch(() => {});
    drawStatus(latest());
    loadStats();
  };

  const content = [h('p', { class: 'muted small', text: 'Con le credenziali della casa il gestionale invia le schedine e scarica le ricevute da solo. Le credenziali si salvano cifrate: dopo il salvataggio nessuno (nemmeno tu) può rileggerle, si possono solo sostituire.' })];

  if (!ready) {
    const keyBox = h('input', { class: 'input mono', readonly: true, value: '', attrs: { 'aria-label': 'Chiave generata' } });
    const gen = h('button', { class: 'btn small', type: 'button', text: 'Genera una chiave', onClick: () => { keyBox.value = randomKey(); keyBox.select(); } });
    const copy = h('button', { class: 'btn small', type: 'button', text: 'Copia', onClick: async () => {
      if (!keyBox.value) keyBox.value = randomKey();
      try { await navigator.clipboard.writeText(keyBox.value); ctx.toast('Chiave copiata'); } catch { keyBox.select(); }
    } });
    content.push(h('div', { class: 'banner warn small', text: 'Prima serve una chiave segreta in Cloudflare (si fa una volta sola).' }),
      h('ol', { class: 'plain-steps' },
        h('li', null, 'Tocca «Genera una chiave» e poi «Copia». La chiave nasce su questo dispositivo e non passa dal gestionale.', h('div', { class: 'btn-row' }, keyBox, gen, copy)),
        h('li', { text: `Su dash.cloudflare.com: Workers e Pages → ${store.info.env === 'produzione' ? 'digihome' : 'digihome-prova'} → Impostazioni → Variabili e segreti → Aggiungi.` }),
        h('li', { text: `Tipo «Segreto», nome ${SECRET_NAME}, valore: incolla la chiave. Poi «Distribuisci».` }),
        h('li', { text: 'Torna qui e ricarica la pagina: comparirà il modulo per le credenziali.' })),
      h('p', { class: 'hint', text: 'La chiave non serve conservarla altrove: se un giorno cambia, basta inserire di nuovo le credenziali di Alloggiati.' }));
  }
  content.push(statusBox, statsBox);

  const utente = h('input', { class: 'input', autocomplete: 'off', maxlength: '60', attrs: { autocapitalize: 'off', spellcheck: 'false' } });
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: '120' });
  const wskey = h('input', { class: 'input', type: 'password', autocomplete: 'off', maxlength: '400' });
  const actions = [h('button', { class: 'btn', type: 'button', text: 'Chiudi', onClick: () => dlg.close() })];
  if (ready) {
    content.push(h('h3', { text: parseStatus(house).configured ? 'Sostituisci le credenziali' : 'Credenziali di Alloggiati Web' }),
      h('div', { class: 'form-grid' },
        field('Utente', utente), field('Password', password),
        field('WsKey (chiave del servizio web)', wskey, { hint: 'Si genera nel portale Alloggiati Web («Genera WsKey»). Quando cambi la password del portale va rigenerata anche questa.' })));
    const saveBtn = h('button', { class: 'btn primary', type: 'button', text: 'Salva e prova' });
    saveBtn.addEventListener('click', busy(saveBtn, 'Salvo e provo…', async () => {
      for (const [el, label] of [[utente, 'l’utente'], [password, 'la password'], [wskey, 'la WsKey']]) {
        if (!el.value.trim()) { setFieldError(el, `Scrivi ${label}`); el.focus(); throw new Error('Compila tutti e tre i campi.'); }
      }
      const res = await store.request('/api/alloggiati/credentials', { method: 'POST', timeout: 90000,
        body: { houseId: house.id, utente: utente.value, password: password.value, wskey: wskey.value } });
      utente.value = ''; password.value = ''; wskey.value = '';
      show(res.result || {});
    }));
    actions.push(saveBtn);
    if (parseStatus(house).configured) {
      const testBtn = h('button', { class: 'btn', type: 'button', text: 'Prova collegamento' });
      testBtn.addEventListener('click', busy(testBtn, 'Provo…', async () => {
        const res = await store.request('/api/alloggiati/check', { method: 'POST', timeout: 90000, body: { houseId: house.id } });
        show(res.result || {});
      }));
      const tablesBtn = h('button', { class: 'btn', type: 'button', text: 'Aggiorna tabelle' });
      tablesBtn.addEventListener('click', busy(tablesBtn, 'Scarico…', async () => {
        const res = await store.request('/api/alloggiati/check', { method: 'POST', timeout: 90000, body: { houseId: house.id, tables: true } });
        show(res.result || {});
      }));
      const removeBtn = h('button', { class: 'btn danger ghost', type: 'button', text: 'Rimuovi credenziali' });
      removeBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Rimuovere le credenziali?', text: 'Il gestionale non potrà più inviare le schedine né scaricare le ricevute di questa casa. Le ricevute già scaricate restano.', okLabel: 'Rimuovi', danger: true });
        if (!ok) return;
        await busy(removeBtn, 'Rimuovo…', async () => {
          await store.request('/api/alloggiati/credentials', { method: 'POST', body: { houseId: house.id, remove: true } });
          result.replaceChildren(h('div', { class: 'banner ok small', text: 'Credenziali rimosse.' }));
        })();
      });
      actions.unshift(removeBtn, tablesBtn, testBtn);
    }
  }
  content.push(result);
  const dlg = openDialog({ title: `Alloggiati Web · ${house.name}`, wide: true, content: h('div', { class: 'stack' }, content), actions });
}

function line(k, v) {
  return h('div', { class: 'acc-line' }, h('dt', { text: k }), h('dd', { text: v }));
}

/* ------------------------------ Archivio: Questura e DMS ------------------------------ */

export function questuraView(ctx, house) {
  const { store, ui } = ctx;
  const st = parseStatus(house);
  const receipts = (store.data.receipts || []).filter((r) => r.house_id === house.id);

  // DMS Puglia per le locazioni turistiche (SPOT Easy): un caricamento per ogni arrivo, entro il 10 del mese dopo.
  // Qui il riepilogo degli arrivi del mese scorso e di questo; il file si scarica dalla scheda della prenotazione.
  const monthStart = `${ui.today.slice(0, 7)}-01`;
  const prevStart = `${addDays(monthStart, -1).slice(0, 7)}-01`;
  const arrivals = store.data.bookings
    .filter((b) => b.house_id === house.id && b.stage !== 'cancellata' && !enteredAfterStay(b) && b.check_in >= prevStart && b.check_in <= ui.today)
    .sort((a, b) => a.check_in.localeCompare(b.check_in));
  const dmsDone = (b) => Boolean(parseSteps(b.checkin_steps).dms);
  const todo = arrivals.filter((b) => !dmsDone(b)).length;
  const deadline = (b) => { const [y, m] = b.check_in.split('-').map(Number); return `10/${String(m === 12 ? 1 : m + 1).padStart(2, '0')}/${m === 12 ? y + 1 : y}`; };
  const arrivalRows = arrivals.map((b) => h('a', { class: 'row row-link', href: `#/p/${b.id}` },
    h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: b.guest_name }),
      h('span', { class: 'row-sub', text: `Arrivo ${fmtShort(b.check_in)} · ${b.guests} ${b.guests === 1 ? 'ospite' : 'ospiti'}${dmsDone(b) ? '' : ` · entro il ${deadline(b)}`}` })),
    tag({ text: dmsDone(b) ? 'Caricato' : 'Da caricare', tone: dmsDone(b) ? 'ok' : 'warn' })));
  const dmsCard = h('section', { class: 'card card-pad stack' },
    h('div', { class: 'section-head acc-card-head' }, h('h2', { text: 'DMS Puglia · SPOT Easy' }),
      arrivals.length ? tag({ text: todo ? `${todo} da caricare` : 'Tutto caricato', tone: todo ? 'warn' : 'ok' }) : null),
    arrivalRows.length ? h('div', { class: 'rows' }, arrivalRows) : h('p', { class: 'hint', text: 'Nessun arrivo questo mese e il mese scorso.' }),
    h('p', { class: 'hint', text: 'Per ogni arrivo: apri la prenotazione → Ospiti e Questura → «Scarica il file per SPOT Easy». Su SPOT Easy (con SPID) tocca «Carica scheda Alloggiati», scegli il file, completa la residenza degli ospiti e conferma. Va fatto entro il 10 del mese dopo; conviene all’arrivo, finché c’è il documento del capo.' }));

  const recRows = receipts.map((r) => h('div', { class: 'row' },
    h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: `Ricevuta del ${r.date.split('-').reverse().join('/')}` }),
      h('span', { class: 'row-sub', text: `${Math.max(1, Math.round(r.size / 1024))} KB · si conserva fino al ${r.purge_after.split('-').reverse().join('/')}` })),
    h('a', { class: 'btn small', href: `/api/receipts/${r.id}`, download: '' }, icon('download', { size: 16 }), 'PDF')));
  const manualDate = { v: addDays(ui.today, -1) };
  const manual = dateField({ value: manualDate.v, label: 'Giorno (gg/mm/aaaa)', today: ui.today, onChange: (s) => { manualDate.v = s; } }).el;
  const recMsg = h('div', { attrs: { 'aria-live': 'polite' } });
  const fetchBtn = h('button', { class: 'btn small', type: 'button', text: 'Scarica dal portale' });
  fetchBtn.addEventListener('click', async () => {
    fetchBtn.disabled = true;
    try {
      const res = await store.request('/api/alloggiati/receipt', { method: 'POST', timeout: 60000, body: { houseId: house.id, date: manualDate.v } });
      const r = res.result || {};
      recMsg.replaceChildren(h('div', { class: ['banner small', r.ok ? 'ok' : 'warn'], text: r.ok ? (r.existing ? 'Ricevuta già presente.' : 'Ricevuta scaricata.') : r.message }));
      await store.load({ force: true }).catch(() => {});
    } catch (e) { recMsg.replaceChildren(h('div', { class: 'banner bad small', text: e.message })); }
    fetchBtn.disabled = false;
  });

  const recCard = h('section', { class: 'card card-pad stack' },
    h('div', { class: 'section-head acc-card-head' }, h('h2', { text: 'Ricevute Alloggiati Web' }),
      tag({ text: st.configured ? (st.error ? 'Da controllare' : 'Collegato') : 'Non collegato', tone: st.configured ? (st.error ? 'warn' : 'ok') : 'neutral' })),
    st.receipt_warning ? h('div', { class: 'banner warn small', text: st.receipt_warning }) : null,
    recRows.length ? h('div', { class: 'rows' }, recRows) : h('p', { class: 'hint', text: 'Nessuna ricevuta ancora. Il giorno dopo ogni invio il gestionale la scarica da sola e la conserva per 5 anni.' }),
    st.configured ? h('div', { class: 'stack acc-tight' }, h('strong', { class: 'small', text: 'Scaricarne una a mano (ultimi 30 giorni, oggi escluso)' }),
      h('div', { class: 'btn-row' }, manual, fetchBtn), recMsg) : null);

  return h('div', { class: 'grid-2 section' }, recCard, dmsCard);
}
