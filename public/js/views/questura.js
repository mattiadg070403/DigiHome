// Questura e DMS: impostazioni del collegamento con Alloggiati Web (solo amministratore),
// impostazioni del DMS Puglia, archivio delle ricevute e file per il DMS.

import { h, icon } from '../dom.js';
import { field, setFieldError, openDialog, confirmDialog, tag } from '../ui.js';
import { dateField } from '../pickers.js';
import { addDays, fmtShort, isIsoDate } from '../../shared/dates.js';

const SECRET_NAME = 'CHIAVE_CREDENZIALI';

export function parseStatus(house) {
  try { return house && house.alloggiati_status ? JSON.parse(house.alloggiati_status) : {}; } catch { return {}; }
}
export function parseDms(house) {
  try { return house && house.dms_settings ? JSON.parse(house.dms_settings) : {}; } catch { return {}; }
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
  content.push(statusBox);

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

/* ------------------------------ DMS: impostazioni ------------------------------ */

export function dmsSettingsDialog(ctx, house) {
  const cur = parseDms(house);
  const rooms = h('input', { class: 'input', inputmode: 'numeric', value: cur.rooms ? String(cur.rooms) : '' });
  const beds = h('input', { class: 'input', inputmode: 'numeric', value: cur.beds ? String(cur.beds) : String(house.max_guests || '') });
  const v = { sent_until: cur.sent_until || null };
  const sent = dateField({ value: v.sent_until, label: 'Data (gg/mm/aaaa)', today: ctx.ui.today, onChange: (s) => { v.sent_until = s; } }).el;
  const dlg = openDialog({
    title: `DMS Puglia · ${house.name}`,
    content: h('div', { class: 'stack' },
      h('p', { class: 'muted small', text: 'Servono per il file del DMS: ogni giorno il file dice quante camere e posti letto ha la casa e se è occupata. Usa gli stessi numeri registrati sul DMS.' }),
      h('div', { class: 'form-grid' }, field('Camere', rooms), field('Posti letto', beds),
        field('Ultimo giorno già comunicato al DMS', sent, { hint: 'Il prossimo file parte dal giorno dopo. Vuoto = non ancora usato.' }))),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
    ],
  });
  async function save() {
    const r = Number(rooms.value);
    const bd = Number(beds.value);
    if (!Number.isInteger(r) || r < 1) { setFieldError(rooms, 'Numero non valido'); return; }
    if (!Number.isInteger(bd) || bd < r) { setFieldError(beds, 'Numero non valido (almeno quanto le camere)'); return; }
    if (v.sent_until && !isIsoDate(v.sent_until)) { dlg.setBanner('Data non valida'); return; }
    try {
      await ctx.act('house.dms', { houseId: house.id, rooms: r, beds: bd, sent_until: v.sent_until }, { message: 'Impostazioni del DMS salvate' });
      dlg.close();
    } catch (e) { dlg.setBanner(e.message); }
  }
}

/* ------------------------------ Archivio: Questura e DMS ------------------------------ */

export function questuraView(ctx, house) {
  const { store, ui } = ctx;
  const st = parseStatus(house);
  const dms = parseDms(house);
  const admin = store.data.me.role === 'admin';
  const receipts = (store.data.receipts || []).filter((r) => r.house_id === house.id);

  // File per il DMS: dal giorno dopo l'ultimo comunicato a ieri (o a oggi, se scelto).
  const defFrom = dms.sent_until ? addDays(dms.sent_until, 1) : addDays(ui.today, -7);
  const per = ui.dmsPeriod && ui.dmsPeriod.house === house.id ? ui.dmsPeriod : (ui.dmsPeriod = { house: house.id, from: defFrom, to: addDays(ui.today, -1) < defFrom ? defFrom : addDays(ui.today, -1) });
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  const fromF = dateField({ value: per.from, label: 'Dal (gg/mm/aaaa)', today: ui.today, onChange: (s) => { per.from = s; } }).el;
  const toF = dateField({ value: per.to, label: 'Al (gg/mm/aaaa)', today: ui.today, onChange: (s) => { per.to = s; } }).el;
  const dl = h('button', { class: 'btn primary', type: 'button' }, icon('download', { size: 16 }), 'Scarica il file per il DMS');
  dl.addEventListener('click', async () => {
    msg.replaceChildren();
    if (!isIsoDate(per.from) || !isIsoDate(per.to) || per.to < per.from) { msg.replaceChildren(h('div', { class: 'banner bad small', text: 'Controlla le date del periodo.' })); return; }
    dl.disabled = true;
    try {
      const res = await fetch(`/api/dms?house=${encodeURIComponent(house.id)}&from=${per.from}&to=${per.to}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
      if (!res.ok || res.type === 'opaqueredirect') {
        let text = 'File non preparato.';
        try { text = (await res.json()).message || text; } catch { text = 'Sessione scaduta: ricarica la pagina.'; }
        msg.replaceChildren(h('div', { class: 'banner bad small', text }));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `DMS-${house.id}-${per.from}-${per.to}.xml` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      msg.replaceChildren(h('div', { class: 'banner ok small' },
        h('span', { text: `File scaricato. Caricalo sul DMS (SPOT Online → «Carica movimentazione»). Quando il DMS l’ha accettato, tocca: ` }),
        h('button', { class: 'btn small', type: 'button', text: `Caricato fino al ${fmtShort(per.to)}`, onClick: async () => {
          try {
            await ctx.act('house.dms', { houseId: house.id, sentOnly: true, sent_until: per.to }, { message: `DMS segnato fino al ${fmtShort(per.to)}` });
            ui.dmsPeriod = null;
          } catch (e) { ctx.toast(e.message, { bad: true }); }
        } })));
    } catch {
      msg.replaceChildren(h('div', { class: 'banner bad small', text: 'Connessione assente: riprova.' }));
    } finally { dl.disabled = false; }
  });

  const dmsCard = h('section', { class: 'card card-pad stack' },
    h('div', { class: 'section-head acc-card-head' }, h('h2', { text: 'DMS Puglia' }),
      admin ? h('button', { class: 'btn small ghost', type: 'button', text: 'Impostazioni', onClick: () => dmsSettingsDialog(ctx, house) }) : null),
    !dms.rooms ? h('div', { class: 'banner warn small', text: admin ? 'Imposta camere e posti letto della casa (Impostazioni qui sopra).' : 'L’amministratore deve impostare camere e posti letto della casa.' }) : null,
    h('p', { class: 'small', text: dms.sent_until ? `Ultimo giorno comunicato: ${fmtShort(dms.sent_until)}.` : 'Non ancora usato: per il primo file scegli un periodo che inizia con la casa vuota.' }),
    h('div', { class: 'stack acc-tight' }, field('Dal', fromF), field('Al', toF)),
    h('div', { class: 'btn-row' }, dl), msg,
    h('p', { class: 'hint', text: 'Il file contiene, giorno per giorno, arrivi e partenze con sesso, età, cittadinanza e residenza degli ospiti (nessun nome né documento). Si entra sul DMS con SPID e si carica il file.' }));

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
