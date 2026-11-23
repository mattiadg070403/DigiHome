// Ospiti della prenotazione e invio alla Questura (Alloggiati Web).
// I dati degli ospiti non sono nello stato dell'app: si scaricano aprendo la scheda e restano solo in memoria.

import { h, icon, newId } from '../dom.js';
import { tag, field, setFieldError, openDialog, confirmDialog, segmented } from '../ui.js';
import { dateField } from '../pickers.js';
import { GROUPS, SEX, TYPE_LABEL, docDropped, guestMissing, guestType, nameTranscription, plainDoc, plainName, sendWindow } from '../../shared/alloggiati.js';
import { addDays, fmtShort, todayRome } from '../../shared/dates.js';
import { waNumber } from './contact.js';

const cache = new Map(); // id prenotazione → { guests, loading, error, at }
let docTypesCache = null;

export function forgetGuests() { cache.clear(); }

function houseStatus(house) {
  try { return house && house.alloggiati_status ? JSON.parse(house.alloggiati_status) : {}; } catch { return {}; }
}
export function alloggiatiReady(house) {
  return Boolean(houseStatus(house).configured);
}

const painters = new Map(); // id prenotazione → pannelli aperti da ridisegnare

function repaint(bookingId) {
  const set = painters.get(bookingId);
  if (!set) return;
  for (const p of [...set]) {
    if (p.box.isConnected) p.draw();
    else set.delete(p);
  }
}

async function loadGuests(ctx, bookingId) {
  const entry = cache.get(bookingId) || {};
  if (entry.loading) return;
  cache.set(bookingId, { ...entry, loading: true, error: null });
  try {
    const res = await ctx.store.request(`/api/bookings/${encodeURIComponent(bookingId)}/guests`);
    cache.set(bookingId, { guests: res.guests || [], loading: false, error: null, at: Date.now() });
  } catch (e) {
    cache.set(bookingId, { ...entry, loading: false, error: e.message });
  }
  repaint(bookingId);
}

async function docTypes(ctx) {
  if (docTypesCache && docTypesCache.length) return docTypesCache;
  try {
    const res = await ctx.store.request('/api/doc-types');
    docTypesCache = res.docTypes || [];
  } catch { docTypesCache = []; }
  return docTypesCache;
}

const placeLabel = (p) => (p ? `${p.name}${p.kind === 'C' && p.province ? ` (${p.province})` : ''}` : '');
const fullName = (g) => `${g.first_name} ${g.last_name}`.trim();

/* ------------------------------ Pannello ------------------------------ */

/**
 * Pannello "Ospiti e Questura": elenco degli ospiti con cosa manca, famiglia/gruppo,
 * invio delle schedine e ricevuta. Si aggiorna da solo quando arrivano i dati.
 */
export function guestsPanel(ctx, b) {
  const box = h('section', { class: 'card card-pad stack guests-panel', attrs: { 'aria-live': 'polite' } });
  const draw = () => box.replaceChildren(...panelContent(ctx, b.id, () => repaint(b.id)).filter(Boolean));
  if (!painters.has(b.id)) painters.set(b.id, new Set());
  painters.get(b.id).add({ box, draw });
  const entry = cache.get(b.id);
  if (!entry || (!entry.loading && !entry.guests && !entry.error) || (entry.at && Date.now() - entry.at > 60000 && !entry.loading)) {
    loadGuests(ctx, b.id);
  }
  draw();
  return box;
}

function panelContent(ctx, bookingId, redraw) {
  const { store, ui } = ctx;
  const b = store.data.bookings.find((x) => x.id === bookingId);
  if (!b) return [];
  const house = store.data.houses.find((x) => x.id === b.house_id);
  const entry = cache.get(b.id) || {};
  const head = h('div', { class: 'extras-head' }, h('h2', { text: 'Ospiti e Questura' }),
    b.guests_entered ? tag({ text: `${b.guests_done} di ${b.guests} completi`, tone: b.guests_done === b.guests && b.guests_entered === b.guests ? 'ok' : 'warn' }) : null);
  if (entry.loading && !entry.guests) return [head, h('p', { class: 'muted small', text: 'Carico i dati degli ospiti…' })];
  if (entry.error && !entry.guests) {
    return [head, h('div', { class: 'banner bad small', text: `Dati degli ospiti non caricati: ${entry.error}` }),
      h('div', null, h('button', { class: 'btn small', type: 'button', text: 'Riprova', onClick: () => loadGuests(ctx, b.id) }))];
  }
  const guests = entry.guests || [];
  const editable = b.stage !== 'cancellata';
  const after = (res) => {
    if (res.record) store.accept([['booking', res.record]]);
    if (res.guests) cache.set(b.id, { guests: res.guests, loading: false, error: null, at: Date.now() });
    redraw();
  };

  const rows = guests.map((g, i) => {
    const type = guestType(i, guests.length, b.guest_group);
    const miss = guestMissing(g, i === 0, { today: ui.today });
    return h('button', { class: 'extra-row row-button guest-row', type: 'button', disabled: !editable,
      onClick: () => guestDialog(ctx, b, g, guests, after) },
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title', text: fullName(g) }),
      h('span', { class: 'row-sub' },
        h('span', { class: 'muted', text: TYPE_LABEL[type] }),
        miss.length ? tag({ text: `Manca: ${miss.join(', ')}`, tone: 'warn' }) : tag({ text: 'Completo', tone: 'ok' }),
        g.doc_purged_at ? h('span', { class: 'muted tiny', text: 'documento cancellato dopo la ricevuta' }) : null)),
    icon('chevron', { size: 16 }));
  });

  const group = guests.length > 1 ? h('div', { class: 'acc-method' },
    h('span', { class: 'small', text: 'Ospiti che viaggiano insieme come' }),
    segmented(Object.entries(GROUPS).map(([k, l]) => ({ value: k, label: l })), b.guest_group || 'famiglia', async (v) => {
      try { after((await guestsRequest(ctx, 'booking.guest_group', { bookingId: b.id, group: v }))); } catch (e) { ctx.toast(e.message, { bad: true }); }
    }, 'Famiglia o gruppo')) : null;

  const add = editable && guests.length < Math.max(b.guests, 1) + 5
    ? h('button', { class: ['btn small', guests.length < b.guests ? 'primary' : null], type: 'button', onClick: () => guestDialog(ctx, b, null, guests, after) },
      icon('plus', { size: 16 }), guests.length ? 'Aggiungi ospite' : 'Inserisci i dati degli ospiti')
    : null;

  const count = guests.length !== b.guests && guests.length
    ? h('p', { class: 'hint warn-text', text: `Inseriti ${guests.length} ospiti, nella prenotazione sono ${b.guests}: aggiungi chi manca o correggi il numero.` }) : null;

  return [head,
    guests.length ? h('div', { class: 'stack extras' }, rows) : h('p', { class: 'hint', text: `Nome, data e luogo di nascita, cittadinanza e residenza di tutti (${b.guests}); per chi prenota anche il documento. Servono per la Questura e per il DMS Puglia.` }),
    count, group, add ? h('div', { class: 'btn-row' }, add) : null,
    formBlock(ctx, b, house),
    questuraBlock(ctx, b, house, guests, after)];
}

/* ------------------------------ Modulo online per l'ospite ------------------------------ */

const firstName = (b) => String(b.guest_name || '').replace(/\s*\(prova\)$/, '').trim().split(/\s+/)[0] || '';

/** Messaggio con il link (italiano o inglese). */
export function formMessage(b, house, link, lang) {
  const name = firstName(b);
  if (lang === 'en') {
    return `Hi${name ? ` ${name}` : ''}, to speed up check-in at ${house.name}, could you please fill in the details of all guests here before you arrive? `
      + `The lead guest's ID document is needed.\n${link}\nIt takes a couple of minutes. Thank you!`;
  }
  return `Ciao${name ? ` ${name}` : ''}, per velocizzare il check-in a ${house.name} ti chiedo di inserire qui, prima dell’arrivo, i dati di tutti gli ospiti `
    + `(serve il documento di chi ha prenotato):\n${link}\nCi vogliono un paio di minuti. Grazie!`;
}

function formBlock(ctx, b, house) {
  const { store, ui } = ctx;
  const base = (store.info.formBases || {})[b.house_id] || store.info.formBase;
  const out = h('div', { class: 'stack questura' }, h('strong', { text: 'Modulo online per l’ospite' }));
  if (b.alloggiati_at || b.stage === 'cancellata') return null;
  if (!base) {
    out.append(h('p', { class: 'hint', text: 'Il modulo online non è ancora attivo: va collegato in Cloudflare (è nella lista dei collegamenti da fare alla fine).' }));
    return out;
  }
  const lastDay = addDays(b.check_in, 1);
  if (ui.today > lastDay) return null;
  const act = (action, message, extra = {}) => ctx.act('booking.guest_link', { id: b.id, action, ...extra }, { message }).catch((e) => ctx.toast(e.message, { bad: true }));
  if (b.guest_form_at) {
    out.append(h('div', null, tag({ text: `Dati inviati dall’ospite il ${fmtShort(todayRome(new Date(b.guest_form_at)))}: controllali all’arrivo`, tone: 'ok' })));
  }
  if (!b.guest_form_token) {
    out.append(h('p', { class: 'hint', text: 'Un link da mandare su WhatsApp: l’ospite inserisce i dati di tutti (anche in inglese) e arrivano qui da soli. All’arrivo controlli i documenti e invii.' }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small primary', type: 'button', onClick: () => act('create', 'Link creato') }, icon('plus', { size: 16 }), 'Crea il link per l’ospite')));
    return out;
  }
  const link = `${base}/${b.guest_form_token}`;
  const send = (lang) => {
    const text = formMessage(b, house, link, lang);
    const n = waNumber(b.phone);
    // Nel tocco: le app aprono WhatsApp solo se la finestra si apre subito.
    window.open(`https://wa.me/${n || ''}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(formMessage(b, house, link, 'it')); ctx.toast('Messaggio con il link copiato'); } catch { ctx.toast('Non riesco a copiare: tieni premuto sul link', { bad: true }); }
  };
  out.append(
    h('p', { class: 'small' }, 'Link: ', h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', class: 'break', text: link })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', type: 'button', onClick: () => send('it') }, icon('chat', { size: 16 }), 'WhatsApp in italiano'),
      h('button', { class: 'btn small', type: 'button', onClick: () => send('en') }, icon('chat', { size: 16 }), 'WhatsApp in inglese'),
      h('button', { class: 'btn small ghost', type: 'button', text: 'Copia il messaggio', onClick: copy })),
    h('p', { class: 'hint', text: `Funziona fino al ${fmtShort(lastDay)} o finché non invii le schedine. Ogni nuovo invio dell’ospite sostituisce il precedente.` }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small ghost', type: 'button', text: 'Crea un link nuovo', onClick: async () => {
        if (await confirmDialog({ title: 'Creare un link nuovo?', text: 'Quello vecchio smette di funzionare.', okLabel: 'Crea' })) act('create', 'Nuovo link creato', { renew: true });
      } }),
      h('button', { class: 'btn small ghost danger', type: 'button', text: 'Disattiva il link', onClick: async () => {
        if (await confirmDialog({ title: 'Disattivare il link?', text: 'L’ospite non potrà più inviare i dati.', okLabel: 'Disattiva', danger: true })) act('revoke', 'Link disattivato');
      } })));
  return out;
}

/* ------------------------------ Questura ------------------------------ */

function questuraBlock(ctx, b, house, guests, after) {
  const { store, ui } = ctx;
  const ready = alloggiatiReady(house);
  const admin = store.data.me.role === 'admin';
  const out = h('div', { class: 'stack questura' }, h('strong', { text: 'Schedine Alloggiati Web' }));
  if (b.alloggiati_at) {
    const day = todayRome(new Date(b.alloggiati_at));
    const rec = (store.data.receipts || []).find((r) => r.house_id === b.house_id && r.date === day);
    out.append(h('div', { class: 'acc-payout' },
      h('div', { class: 'stack acc-tight' },
        tag({ text: `Inviate il ${fmtShort(day)} (${b.alloggiati_count || '?'} schedine)`, tone: 'ok' }),
        rec ? h('span', { class: 'small', text: 'Ricevuta della Questura scaricata e conservata (5 anni).' })
          : h('span', { class: 'small muted', text: day >= ui.today ? 'La ricevuta si scarica da sola da domani.' : 'Ricevuta in arrivo: il gestionale la scarica da solo.' })),
      rec ? h('a', { class: 'btn small', href: `/api/receipts/${rec.id}`, download: '' }, icon('download', { size: 16 }), 'Ricevuta PDF') : null));
  }
  const err = b.alloggiati_error && !b.alloggiati_error.startsWith('IN_CORSO:') ? b.alloggiati_error : null;
  if (err) out.append(h('div', { class: 'banner bad small', attrs: { role: 'alert' }, text: err }));
  if (!ready) {
    out.append(h('p', { class: 'hint', text: admin
      ? 'Invio automatico non impostato per questa casa: inserisci le credenziali in Impostazioni → Case → Alloggiati Web. Intanto puoi inviarle dal portale e spuntare il passaggio nel check-in.'
      : 'Invio automatico non impostato per questa casa: invia le schedine dal portale e spunta il passaggio nel check-in.' }));
    return out;
  }
  const win = sendWindow(b.check_in, ui.today);
  const miss = guests.map((g, i) => guestMissing(g, i === 0, { today: ui.today })).filter((m) => m.length).length;
  let reason = null;
  if (b.stage === 'cancellata') reason = 'Prenotazione cancellata.';
  else if (!guests.length) reason = 'Prima inserisci i dati degli ospiti.';
  else if (guests.length !== b.guests) reason = `Servono i dati di tutti gli ospiti (${guests.length} su ${b.guests}).`;
  else if (miss) reason = 'Completa i dati degli ospiti segnati in arancione.';
  else if (!win.ok) reason = win.text;
  if (b.alloggiati_at && !win.ok) return out;
  const btn = h('button', { class: ['btn', b.alloggiati_at ? 'small ghost' : 'primary'], type: 'button', disabled: Boolean(reason),
    onClick: () => sendNow(ctx, b, guests, Boolean(b.alloggiati_at), btn) },
  icon('check', { size: 16 }), b.alloggiati_at ? 'Invia di nuovo' : `Invia alla Questura (${guests.length})`);
  out.append(h('div', { class: 'btn-row' }, btn));
  if (reason && !b.alloggiati_at) out.append(h('p', { class: 'hint', text: reason }));
  else if (!b.alloggiati_at) out.append(h('p', { class: 'hint', text: 'Prima il portale controlla le schedine: se trova un errore non invia niente e te lo dice.' }));
  return out;
}

async function sendNow(ctx, b, guests, again, btn) {
  const ok = await confirmDialog({
    title: again ? 'Inviare di nuovo le schedine?' : `Inviare ${guests.length} schedine alla Questura?`,
    text: again
      ? 'Le schedine sono già state inviate: un nuovo invio crea un doppione sul portale. Fallo solo se te lo chiede la Questura o se il primo invio aveva errori.'
      : `Sulle schedine: ${guests.map((g) => `${plainName(g.last_name)} ${plainName(g.first_name)}`).join(', ')}. Hai controllato i documenti di persona?`,
    okLabel: again ? 'Invia di nuovo' : 'Invia', danger: again,
  });
  if (!ok) return;
  btn.disabled = true;
  btn.replaceChildren('Invio in corso…');
  try {
    const res = await ctx.store.request('/api/alloggiati/send', { method: 'POST', body: { bookingId: b.id, again }, timeout: 90000 });
    const r = res.result || {};
    if (r.record) ctx.store.accept([['booking', r.record]]);
    if (r.ok) {
      ctx.toast(`Schedine inviate alla Questura (${r.count})`);
      cache.delete(b.id);
    } else {
      showSendErrors(r);
    }
  } catch (e) {
    if (e.code === 'network') {
      showSendErrors({ message: 'La risposta non è arrivata (connessione lenta?). Prima di riprovare aggiorna la pagina: se le schedine risultano inviate non serve rifarlo.' });
    } else showSendErrors({ message: e.message });
  }
  ctx.render();
}

function showSendErrors(r) {
  const dlg = openDialog({
    title: 'Schedine non inviate',
    content: h('div', { class: 'stack' },
      h('p', { text: r.message || 'Errore sconosciuto.' }),
      r.errors && r.errors.length ? h('ul', { class: 'plain-list' }, r.errors.map((x) => h('li', { text: `${x.guest}: ${x.error}` }))) : null,
      r.stage === 'send' && r.accepted ? h('p', { class: 'hint', text: 'Alcune schedine sono state accettate: correggi solo quelle sbagliate e, se serve, chiedi alla Questura come procedere.' }) : null),
    actions: [h('button', { class: 'btn primary', type: 'button', text: 'Ho capito', onClick: () => dlg.close() })],
  });
}

/* ------------------------------ Richieste ------------------------------ */

async function guestsRequest(ctx, type, payload) {
  return ctx.store.request('/api/guests', { method: 'POST', body: { opId: newId(), type, payload }, timeout: 20000 });
}

/* ------------------------------ Luoghi ------------------------------ */

/**
 * Campo per scegliere un luogo dalle tabelle ufficiali (comuni italiani e stati).
 * kind: 'C' solo comuni, 'S' solo stati, null entrambi.
 */
export function placeField(ctx, { code, name, kind = null, placeholder, onChange }) {
  const wrap = h('div', { class: 'place-field' });
  const listId = `pl-${newId().slice(0, 8)}`;
  const input = h('input', { class: 'input', autocomplete: 'off', value: name || '', placeholder: placeholder || (kind === 'S' ? 'Scrivi lo stato…' : 'Scrivi il comune o lo stato…'),
    attrs: { role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', 'aria-controls': listId, spellcheck: 'false', autocapitalize: 'characters' } });
  const list = h('ul', { class: 'place-list', id: listId, attrs: { role: 'listbox' } });
  list.hidden = true;
  let items = [];
  let active = -1;
  let timer = null;
  let seq = 0;
  let chosen = code ? { code, name } : null;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const pick = (p) => {
    chosen = p;
    input.value = placeLabel(p);
    setFieldError(input, '');
    close();
    onChange(p.code, p);
  };
  const paint = (message) => {
    list.replaceChildren(...(message ? [h('li', { class: 'place-empty', text: message })] : items.map((p, i) => h('li', {
      class: ['place-item', i === active && 'active'], attrs: { role: 'option', 'aria-selected': String(i === active) },
      onPointerdown: (e) => { e.preventDefault(); pick(p); },
    }, h('span', { text: placeLabel(p) }), h('span', { class: 'muted tiny', text: `${p.kind === 'C' ? 'comune' : 'stato'}${p.active === 0 ? ' non più esistente' : ''}` })))));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const search = async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    const my = ++seq;
    try {
      const res = await ctx.store.request(`/api/places?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}`);
      if (my !== seq) return;
      items = res.places || [];
      active = items.length ? 0 : -1;
      paint(items.length ? null : 'Nessun luogo trovato. Se l’elenco è vuoto, le tabelle ufficiali non sono ancora scaricate (Impostazioni → Case → Alloggiati Web).');
    } catch (e) {
      if (my === seq) paint(`Ricerca non riuscita: ${e.message}`);
    }
  };
  input.addEventListener('input', () => {
    if (chosen) { chosen = null; onChange(null, null); }
    clearTimeout(timer);
    timer = setTimeout(search, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (e.key === 'Enter') {
      if (active >= 0 && items[active]) { e.preventDefault(); pick(items[active]); }
    } else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      close();
      if (!chosen && input.value.trim()) setFieldError(input, 'Scegli il luogo dall’elenco che compare mentre scrivi');
    }, 150);
  });
  wrap.append(input, list);
  return { el: wrap, input, isValid: () => Boolean(chosen) || !input.value.trim() };
}

/* ------------------------------ Scheda dell'ospite ------------------------------ */

function guestDialog(ctx, b, existing, guests, after) {
  const index = existing ? guests.findIndex((g) => g.id === existing.id) : guests.length;
  const leader = index === 0;
  const lead = guests[0];
  const v = {
    last_name: existing?.last_name || '', first_name: existing?.first_name || '', sex: existing?.sex || null,
    birth_date: existing?.birth_date || null, birth_place: existing?.birth_place || null, citizenship: existing?.citizenship || null,
    residence: existing?.residence || null, doc_type: existing?.doc_type || null, doc_number: existing?.doc_number || '', doc_place: existing?.doc_place || null,
  };
  const names = {
    birth_place: existing?.birth_place_name ? placeLabel({ name: existing.birth_place_name, province: existing.birth_place_province, kind: existing.birth_place_kind }) : '',
    citizenship: existing?.citizenship_name || '',
    residence: existing?.residence_name ? placeLabel({ name: existing.residence_name, province: existing.residence_province, kind: existing.residence_kind }) : '',
    doc_place: existing?.doc_place_name || '',
  };
  // Anteprima di come i dati arrivano alla Questura (maiuscole, senza accenti): niente si perde in silenzio.
  const preview = h('div', { class: 'transcript', attrs: { 'aria-live': 'polite' } });
  const drawPreview = () => {
    const ln = nameTranscription(v.last_name);
    const fn = nameTranscription(v.first_name);
    const lost = [...new Set([...ln.dropped, ...fn.dropped])];
    const docLost = leader ? [...new Set(docDropped(v.doc_number))] : [];
    preview.replaceChildren(...[
      h('div', null, h('span', { class: 'muted', text: 'Sulla schedina: ' }), h('strong', { class: 'mono', text: `${ln.text || '…'} ${fn.text || '…'}` }),
        leader && plainDoc(v.doc_number) ? h('span', null, h('span', { class: 'muted', text: ' · documento ' }), h('strong', { class: 'mono', text: plainDoc(v.doc_number) })) : null),
      lost.length ? h('div', { class: 'warn-text', text: `La Questura non accetta: ${lost.join(' ')}. Scrivi il nome in lettere latine, come sul passaporto.` }) : null,
      docLost.length ? h('div', { class: 'warn-text', text: `Nel numero del documento solo lettere e numeri (togli ${docLost.join(' ')}).` }) : null,
    ].filter(Boolean));
  };
  const text = (key, max, extra = {}) => h('input', { class: 'input', maxlength: String(max), autocomplete: 'off', value: v[key] || '', ...extra,
    onInput: (e) => { v[key] = e.target.value; setFieldError(e.target, ''); drawPreview(); } });
  const last = text('last_name', 50, { autocapitalize: 'words' });
  const first = text('first_name', 30, { autocapitalize: 'words' });
  const sexBox = h('div');
  const drawSex = () => sexBox.replaceChildren(segmented(Object.entries(SEX).map(([k, l]) => ({ value: k, label: l })), v.sex, (s) => { v.sex = s; drawSex(); }, 'Sesso'));
  drawSex();
  const birth = dateField({ value: v.birth_date, label: 'Data di nascita (gg/mm/aaaa)', today: ctx.ui.today, calendar: false, onChange: (s) => { v.birth_date = s; } }).el;
  const places = {};
  const mk = (key, kind, placeholder) => {
    places[key] = placeField(ctx, { code: v[key], name: names[key], kind, placeholder, onChange: (c) => { v[key] = c; } });
    return places[key].el;
  };
  const docType = h('select', { class: 'input', onChange: (e) => { v.doc_type = e.target.value || null; } }, h('option', { value: '', text: 'Carico i tipi…' }));
  if (leader) {
    docTypes(ctx).then((list) => {
      docType.replaceChildren(h('option', { value: '', text: list.length ? 'Scegli…' : 'Tabelle non ancora scaricate' }),
        ...list.map((t) => h('option', { value: t.code, text: t.name, selected: t.code === v.doc_type })));
    });
  }
  const docNum = text('doc_number', 30, { autocapitalize: 'characters' });
  const copyBtn = !leader && lead ? h('button', { class: 'btn small ghost copy-lead', type: 'button', text: `Cittadinanza e residenza come ${lead.first_name}`,
    onClick: () => {
      v.citizenship = lead.citizenship;
      v.residence = lead.residence;
      const c = placeField(ctx, { code: v.citizenship, name: lead.citizenship_name || '', kind: 'S', onChange: (x) => { v.citizenship = x; } });
      places.citizenship.el.replaceWith(c.el);
      places.citizenship = c;
      const r = placeField(ctx, { code: v.residence, name: lead.residence_name ? placeLabel({ name: lead.residence_name, province: lead.residence_province, kind: lead.residence_kind }) : '',
        onChange: (x) => { v.residence = x; } });
      places.residence.el.replaceWith(r.el);
      places.residence = r;
    } }) : null;

  const actions = [
    h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
    h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
  ];
  if (existing) {
    actions.unshift(h('button', { class: 'btn danger ghost', type: 'button', text: 'Elimina', onClick: remove }));
    if (!leader) actions.unshift(h('button', { class: 'btn ghost', type: 'button', text: b.guest_group === 'gruppo' ? 'Rendi capogruppo' : 'Rendi capofamiglia', onClick: makeLeader }));
  }
  const type = guestType(index, Math.max(guests.length + (existing ? 0 : 1), 1), b.guest_group);
  const dlg = openDialog({
    title: existing ? fullName(existing) : 'Nuovo ospite',
    wide: true,
    content: h('div', { class: 'stack' },
      h('p', { class: 'muted small', text: `${TYPE_LABEL[type]}. ${leader ? 'Per chi prenota serve anche il documento.' : 'Il documento serve solo a chi prenota.'} Scrivi come sul documento: accenti e simboli si sistemano da soli.` }),
      h('div', { class: 'form-grid' },
        field('Cognome', last), field('Nome', first)),
      preview,
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('div', { class: 'label', text: 'Sesso' }), sexBox), field('Data di nascita', birth),
        field('Luogo di nascita', mk('birth_place', null), { hint: 'Comune italiano oppure stato estero' }),
        field('Cittadinanza', mk('citizenship', 'S', 'Scrivi lo stato (es. Italia)…')),
        field('Residenza', mk('residence', null), { hint: 'Comune italiano oppure stato estero (per il DMS)' })),
      copyBtn,
      leader ? h('h3', { text: 'Documento' }) : null,
      leader ? h('div', { class: 'form-grid' },
        field('Tipo di documento', docType), field('Numero', docNum),
        field('Luogo di rilascio', mk('doc_place', null), { hint: 'Comune italiano oppure stato estero' })) : null,
      existing && existing.doc_purged_at ? h('p', { class: 'hint', text: 'I dati del documento sono stati cancellati dopo la ricevuta della Questura.' }) : null),
    actions,
  });
  drawPreview();

  async function save() {
    dlg.setBanner('');
    if (!v.last_name.trim()) { setFieldError(last, 'Scrivi il cognome'); last.focus(); return; }
    if (!v.first_name.trim()) { setFieldError(first, 'Scrivi il nome'); first.focus(); return; }
    if (nameTranscription(v.last_name).dropped.length || nameTranscription(v.first_name).dropped.length) {
      dlg.setBanner('Ci sono caratteri che la Questura non accetta: scrivi nome e cognome in lettere latine, come sul passaporto.');
      return;
    }
    if (leader && docDropped(v.doc_number).length) { setFieldError(docNum, 'Solo lettere e numeri'); docNum.focus(); return; }
    for (const p of Object.values(places)) if (!p.isValid()) { p.input.focus(); dlg.setBanner('Scegli i luoghi dall’elenco che compare mentre scrivi.'); return; }
    const guest = { ...v, doc_number: (v.doc_number || '').trim() || null };
    if (!leader) { guest.doc_type = null; guest.doc_number = null; guest.doc_place = null; }
    try {
      const res = await guestsRequest(ctx, 'guest.save', { bookingId: b.id, id: existing ? existing.id : newId(), version: existing ? existing.version : undefined, guest });
      dlg.close();
      after(res);
      const miss = guestMissing(res.guests[index] || {}, leader, { today: ctx.ui.today });
      ctx.toast(miss.length ? `Salvato. Manca ancora: ${miss.join(', ')}` : 'Ospite salvato');
    } catch (e) { dlg.setBanner(e.message); }
  }
  async function remove() {
    const ok = await confirmDialog({ title: `Eliminare ${fullName(existing)}?`, text: 'I suoi dati vengono tolti dalla prenotazione.', okLabel: 'Elimina', danger: true });
    if (!ok) return;
    try { const res = await guestsRequest(ctx, 'guest.delete', { id: existing.id }); dlg.close(); after(res); } catch (e) { dlg.setBanner(e.message); }
  }
  async function makeLeader() {
    try { const res = await guestsRequest(ctx, 'guest.leader', { id: existing.id }); dlg.close(); after(res); ctx.toast('Fatto: ricorda il documento'); } catch (e) { dlg.setBanner(e.message); }
  }
}

/** Finestra "Ospiti e Questura" (dal passaggio del check-in). */
export function openGuests(ctx, b) {
  const dlg = openDialog({
    title: `Ospiti e Questura · ${b.guest_name}`,
    wide: true,
    content: guestsPanel(ctx, b),
    actions: [h('button', { class: 'btn primary', type: 'button', text: 'Chiudi', onClick: () => { dlg.close(); ctx.render(); } })],
    onClose: () => ctx.render(),
  });
}
