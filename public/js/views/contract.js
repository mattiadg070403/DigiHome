// Contratto digitale: lettura, dati dell'ospite, firme sull'iPad, PDF e invio.
// Solo per le prenotazioni dirette. La firma si fa solo con la connessione attiva: il testo firmato
// è quello che il server ricrea e conserva, con data, ora e impronta.
// Dati e firme scritti nella finestra NON si salvano sul dispositivo come bozza (sono dati personali).

import { h, icon, newId } from '../dom.js';
import { houseVars, field, setFieldError, openDialog, confirmDialog, segmented } from '../ui.js';
import { formatItDate, fmtShort } from '../../shared/dates.js';
import { parseSteps } from '../../shared/booking.js';
import { GUEST_FIELDS, LANGS, checkGuest, guestParagraph, romeDateTime } from '../../shared/contract.js';
import { buildPdf, pdfFileName } from '../pdf.js';
import { waNumber } from './contact.js';

const STAGES = ['confermata', 'in_casa'];

/** Contratto valido di una prenotazione (solo i dati generali), o null. */
export function contractOf(data, bookingId) {
  return data.contracts.find((c) => c.booking_id === bookingId && !c.deleted) || null;
}

function isAdmin(ctx) {
  return ctx.store.data.me?.role === 'admin';
}

/** Cosa fare quando si tocca "Contratto" (scheda o check-in). */
export function openContract(ctx, b) {
  const d = ctx.store.data;
  const c = contractOf(d, b.id);
  if (c) return openSigned(ctx, c);
  const house = d.houses.find((x) => x.id === b.house_id);
  const paper = Boolean(parseSteps(b.checkin_steps).contratto);
  if (paper) return paperDialog(ctx, b);
  if (!STAGES.includes(b.stage)) {
    const dlg = openDialog({ title: 'Contratto', content: h('p', { text: 'Per questa prenotazione non c’è un contratto firmato sul dispositivo.' }),
      actions: [h('button', { class: 'btn', type: 'button', text: 'Chiudi', onClick: () => dlg.close() })] });
    return dlg;
  }
  if (!house.contract_ready) return missingDialog(ctx, b, house);
  return signDialog(ctx, b, house);
}

/* ------------------------------ Scheda: riquadro ------------------------------ */

export function contractPanel(ctx, b) {
  const d = ctx.store.data;
  const c = contractOf(d, b.id);
  const house = d.houses.find((x) => x.id === b.house_id);
  const paper = Boolean(parseSteps(b.checkin_steps).contratto);
  let content;
  if (c) {
    const when = romeDateTime(c.signed_at);
    const changed = c.check_in !== b.check_in || c.check_out !== b.check_out || c.guests !== b.guests;
    content = [
      h('div', { class: 'contract-state ok' }, icon('check', { size: 16 }), h('span', { text: `Firmato il ${when.date} alle ${when.time}${c.lang === 'en' ? ' · in inglese' : ''}` })),
      changed ? h('div', { class: 'banner warn small', text: 'Date o persone della prenotazione sono cambiate dopo la firma: se serve, rifai il contratto.' }) : null,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onClick: () => openSigned(ctx, c) }, icon('download', { size: 16 }), 'Invia o scarica il PDF')),
    ];
  } else if (paper) {
    content = [h('div', { class: 'contract-state ok' }, icon('check', { size: 16 }), h('span', { text: 'Firmato su carta' }))];
  } else if (!STAGES.includes(b.stage)) {
    content = [h('p', { class: 'muted', text: 'Nessun contratto firmato sul dispositivo.' })];
  } else if (!house.contract_ready) {
    content = [
      h('p', { class: 'muted', text: 'Per far firmare il contratto mancano alcuni dati della casa (locatore, indirizzo, CIN).' }),
      isAdmin(ctx) ? h('div', { class: 'btn-row' }, h('a', { class: 'btn small', href: '#/impostazioni', text: 'Completa in Impostazioni' })) : h('p', { class: 'muted small', text: 'Chiedi all’amministratore di completarli.' }),
    ];
  } else {
    content = [
      h('p', { class: 'muted', text: 'Da far leggere e firmare all’ospite all’arrivo, sull’iPad.' }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small house', type: 'button', onClick: () => signDialog(ctx, b, house) }, icon('edit', { size: 16 }), 'Fai firmare il contratto')),
    ];
  }
  return h('section', { class: 'card card-pad stack' }, h('h2', { text: 'Contratto' }), content);
}

/* ------------------------------ Casi particolari ------------------------------ */

function missingDialog(ctx, b, house) {
  const admin = isAdmin(ctx);
  const dlg = openDialog({
    title: 'Contratto',
    content: h('div', { class: 'stack' },
      h('p', { text: `Per far firmare il contratto di ${house.name} mancano alcuni dati della casa: locatore, indirizzo e codice CIN.` }),
      h('p', { class: 'muted', text: admin ? 'Completali in Impostazioni → Case → Dati del contratto.' : 'Chiedi all’amministratore di completarli in Impostazioni.' })),
    actions: [
      paperButton(ctx, b, () => dlg.close()),
      admin ? h('button', { class: 'btn primary', type: 'button', text: 'Vai a Impostazioni', onClick: () => { dlg.close(); ctx.go('impostazioni'); } })
        : h('button', { class: 'btn', type: 'button', text: 'Chiudi', onClick: () => dlg.close() }),
    ],
  });
  return dlg;
}

function paperDialog(ctx, b) {
  const house = ctx.store.data.houses.find((x) => x.id === b.house_id);
  const canEdit = STAGES.includes(b.stage);
  const dlg = openDialog({
    title: 'Contratto firmato su carta',
    content: h('p', { text: 'Il contratto risulta firmato su carta. Se preferisci, puoi togliere la spunta e farlo firmare sull’iPad.' }),
    actions: [
      canEdit ? h('button', { class: 'btn', type: 'button', text: 'Togli la spunta', onClick: async () => {
        dlg.close();
        await setPaper(ctx, b, false);
      } }) : null,
      canEdit && house.contract_ready ? h('button', { class: 'btn house', type: 'button', text: 'Firma sull’iPad', onClick: async () => {
        dlg.close();
        if (await setPaper(ctx, b, false)) signDialog(ctx, ctx.store.data.bookings.find((x) => x.id === b.id) || b, house);
      } }) : h('button', { class: 'btn', type: 'button', text: 'Chiudi', onClick: () => dlg.close() }),
    ],
  });
  return dlg;
}

async function setPaper(ctx, b, done) {
  try {
    await ctx.act('booking.step', { id: b.id, flow: 'checkin', step: 'contratto', done }, { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function paperButton(ctx, b, close) {
  if (!STAGES.includes(b.stage)) return null;
  return h('button', { class: 'btn ghost small', type: 'button', text: 'Firmato su carta', onClick: async () => {
    const ok = await confirmDialog({ title: 'Contratto su carta', text: 'Segno il contratto come firmato su carta? Il foglio firmato conservalo tu.', okLabel: 'Sì, firmato su carta' });
    if (!ok) return;
    close();
    if (await setPaper(ctx, b, true)) ctx.toast('Contratto segnato come firmato su carta');
  } });
}

/* ------------------------------ Firma ------------------------------ */

/** Riquadro per firmare con il dito o con la penna. */
function signaturePad(label, onChange) {
  const canvas = h('canvas', { class: 'sig-canvas', attrs: { role: 'img', 'aria-label': label } });
  const hint = h('span', { class: 'sig-hint', text: 'Firma qui' });
  const strokes = []; // punti in proporzione (0-1), così la firma resta giusta se il riquadro cambia misura
  let current = null;
  let size = { w: 0, h: 0 };

  const ctx2d = () => canvas.getContext('2d');
  function fit() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    size = { w: r.width, h: r.height };
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    const g = ctx2d();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  function lineWidth(w) { return Math.max(2, w * 0.0065); }
  function drawStroke(g, s, w, hh) {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#111';
    g.lineWidth = lineWidth(w);
    g.beginPath();
    s.forEach((p, i) => (i ? g.lineTo(p[0] * w, p[1] * hh) : g.moveTo(p[0] * w, p[1] * hh)));
    if (s.length === 1) g.lineTo(s[0][0] * w + 0.1, s[0][1] * hh);
    g.stroke();
  }
  function redraw() {
    const g = ctx2d();
    g.clearRect(0, 0, size.w, size.h);
    for (const s of strokes) drawStroke(g, s, size.w, size.h);
    hint.hidden = strokes.length > 0;
  }
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    if (!size.w) fit();
    canvas.setPointerCapture(e.pointerId);
    current = [point(e)];
    strokes.push(current);
    hint.hidden = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) current.push(point(ev));
    const g = ctx2d();
    drawStroke(g, current.slice(-Math.min(current.length, evs.length + 1)), size.w, size.h);
  });
  const end = () => { if (current) { current = null; onChange(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fit()).observe(canvas);

  const clear = () => { strokes.length = 0; redraw(); onChange(); };
  const el = h('div', { class: 'sig' },
    h('div', { class: 'sig-head' }, h('span', { class: 'label', text: label }),
      h('button', { class: 'btn ghost small', type: 'button', text: 'Cancella', onClick: clear })),
    h('div', { class: 'sig-box' }, canvas, hint));

  return {
    el,
    fit,
    /** Firma vera: almeno un tratto di una certa lunghezza (non un punto per sbaglio). */
    isEmpty() {
      let len = 0;
      for (const s of strokes) for (let i = 1; i < s.length; i++) len += Math.hypot((s[i][0] - s[i - 1][0]) * size.w, (s[i][1] - s[i - 1][1]) * size.h);
      return len < 40;
    },
    get touched() { return strokes.length > 0; },
    /** Immagine JPEG su sfondo bianco, di misura fissa (larga 600 punti). */
    toJpeg() {
      const w = 600;
      const hh = Math.max(120, Math.round((600 * (size.h || 180)) / (size.w || 600)));
      const off = document.createElement('canvas');
      off.width = w;
      off.height = hh;
      const g = off.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, hh);
      for (const s of strokes) drawStroke(g, s, w, hh);
      return off.toDataURL('image/jpeg', 0.85);
    },
  };
}

/** "testo **grassetto** testo" → nodi di testo e <strong> (mai interpretato come HTML). */
function rich(text) {
  return String(text ?? '').split('**').map((part, i) => (i % 2 ? h('strong', { text: part }) : part)).filter((x) => x !== '');
}

/** Testo del contratto (dal server) con la riga dell'ospite che si aggiorna mentre si scrive. */
function contractView(blocks, guestEl) {
  let list = null;
  const nodes = [];
  for (const b of blocks) {
    if (b.t !== 'li') list = null;
    if (b.t === 'title') nodes.push(h('h3', { class: 'ct-title' }, rich(b.text)));
    else if (b.t === 'center') nodes.push(h('p', { class: 'ct-center' }, rich(b.text)));
    else if (b.t === 'h' || b.t === 'privacy-h') nodes.push(h('h4', { class: ['ct-h', b.t === 'privacy-h' && 'ct-privacy-h'] }, rich(b.text)));
    else if (b.t === 'guest') nodes.push(guestEl);
    else if (b.t === 'li') {
      if (!list) { list = h('ul', { class: 'ct-list' }); nodes.push(list); }
      list.append(h('li', null, rich(b.text)));
    } else if (b.t === 'sign') continue;
    else nodes.push(h('p', { class: [b.t === 'privacy' && 'ct-small', b.t === 'place' && 'ct-place'] }, rich(b.text)));
  }
  return h('div', { class: 'contract-text', tabindex: '0', attrs: { 'aria-label': 'Testo del contratto' } }, nodes);
}

function adultMax(today) {
  const [y, m, d] = today.split('-');
  return `${Number(y) - 18}-${m}-${d}`;
}

export function signDialog(ctx, b, house) {
  const { store, ui } = ctx;
  const g = { sal: 'M', name: String(b.guest_name || '').replace(/\s*\(prova\)$/, '').trim(), birth_place: '', birth_date: '', residence: '', tax_code: '', doc_number: '' };
  let dirty = false;
  let accepted = false;
  let sending = false;
  let last = null; // ultimo invio: stesso codice se si riprova con gli stessi dati
  let lang = 'it';
  let loadSeq = 0;

  const guestEl = h('p', { class: 'ct-guest' });
  const updateGuest = () => { guestEl.replaceChildren(...rich(guestParagraph(g, lang))); };
  updateGuest();

  const inputs = {};
  const mk = (k, attrs = {}) => {
    const el = h('input', { class: 'input', value: g[k], autocomplete: 'off', attrs: { autocapitalize: k === 'tax_code' || k === 'doc_number' ? 'characters' : 'words', spellcheck: 'false' }, ...attrs,
      onInput: (e) => { g[k] = e.target.value; dirty = true; setFieldError(el, ''); updateGuest(); } });
    inputs[k] = el;
    return el;
  };
  const salSeg = h('div');
  const drawSal = () => salSeg.replaceChildren(segmented([{ value: 'M', label: 'Sig.' }, { value: 'F', label: 'Sig.ra' }], g.sal, (v) => { g.sal = v; dirty = true; drawSal(); updateGuest(); }, 'Titolo'));
  drawSal();

  const form = h('div', { class: 'form-grid' },
    h('div', { class: 'field full' }, h('div', { class: 'label', text: 'Titolo' }), salSeg),
    field(GUEST_FIELDS.name, mk('name'), { full: true }),
    field(GUEST_FIELDS.birth_place, mk('birth_place')),
    field(GUEST_FIELDS.birth_date, mk('birth_date', { type: 'date', max: adultMax(ui.today), min: '1900-01-01' })),
    field(GUEST_FIELDS.residence, mk('residence'), { full: true, hint: 'Via, numero, città (e Stato, se all’estero)' }),
    field(GUEST_FIELDS.tax_code, mk('tax_code'), { hint: 'Facoltativo per gli ospiti stranieri' }),
    field(GUEST_FIELDS.doc_number, mk('doc_number')));

  const textBox = h('div', { class: 'contract-wrap' }, h('p', { class: 'muted', text: 'Carico il testo del contratto…' }));
  const langSeg = h('div');
  const drawLang = () => langSeg.replaceChildren(segmented(Object.entries(LANGS).map(([value, label]) => ({ value, label })), lang,
    (v) => { lang = v; drawLang(); updateGuest(); acceptText.textContent = ACCEPT[lang]; loadDraft(); }, 'Lingua del contratto'));
  const ACCEPT = {
    it: 'L’ospite ha letto il contratto e l’informativa sulla privacy e li accetta.',
    en: 'The guest has read the agreement and the privacy notice and accepts them. (L’ospite ha letto contratto e informativa e li accetta.)',
  };
  const acceptText = h('span', { text: ACCEPT.it });
  drawLang();
  const acceptBox = h('input', { type: 'checkbox', id: newId(), onChange: (e) => { accepted = e.target.checked; dirty = true; } });
  const padGuest = signaturePad('Firma dell’ospite', () => { dirty = true; });
  const padHost = signaturePad('Firma del locatore', () => { dirty = true; });
  const saveBtn = h('button', { class: 'btn house', type: 'button', text: 'Firma e salva', disabled: true, onClick: save });

  const content = h('div', { class: 'stack contract-dialog', vars: houseVars(house) },
    h('p', { class: 'muted', text: 'Fai leggere il contratto all’ospite, scrivi i suoi dati come sul documento e poi firmate tutti e due.' }),
    h('section', { class: 'stack' }, h('h3', { text: 'Dati dell’ospite (chi firma)' }), form),
    h('section', { class: 'stack' },
      h('div', { class: 'sig-head' }, h('h3', { text: 'Contratto' }), langSeg),
      textBox),
    h('label', { class: 'accept-row', for: acceptBox.id }, acceptBox, acceptText),
    h('div', { class: 'sig-grid' }, padGuest.el, padHost.el),
    h('p', { class: 'muted small', text: 'I dati e le firme si salvano solo premendo "Firma e salva", e solo con la connessione attiva.' }));

  const dlg = openDialog({
    title: `Contratto · ${house.name}`,
    wide: true,
    content,
    actions: [
      paperButton(ctx, b, () => dlg.close()),
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.requestClose() }),
      saveBtn,
    ],
    canClose: async () => !dirty || sending === 'done' || confirmDialog({ title: 'Uscire senza firmare?', text: 'I dati e le firme scritti si perdono (non restano sul dispositivo).', okLabel: 'Esci', danger: true }),
  });
  for (const [k, v] of Object.entries(houseVars(house))) dlg.el.style.setProperty(k, v);
  requestAnimationFrame(() => { padGuest.fit(); padHost.fit(); });

  // Testo del contratto: lo prepara il server (con i dati della casa e della prenotazione), nella lingua scelta.
  function loadDraft() {
    const seq = ++loadSeq;
    saveBtn.disabled = true;
    textBox.replaceChildren(h('p', { class: 'muted', text: 'Carico il testo del contratto…' }));
    store.request(`/api/bookings/${encodeURIComponent(b.id)}/contract-draft?lang=${lang}`).then((res) => {
      if (dlg.closed || seq !== loadSeq) return;
      if (!res.ready) {
        textBox.replaceChildren(h('div', { class: 'banner warn', text: `Mancano dati della casa: ${res.missing.join(', ')}.` }));
        return;
      }
      textBox.replaceChildren(contractView(res.blocks, guestEl));
      saveBtn.disabled = false;
    }).catch((e) => {
      if (dlg.closed || seq !== loadSeq) return;
      textBox.replaceChildren(h('div', { class: 'banner warn' }, h('span', { text: e.code === 'network' ? 'Serve la connessione per aprire il contratto.' : e.message }),
        h('button', { class: 'btn small', type: 'button', text: 'Riprova', onClick: loadDraft })));
    });
  }
  loadDraft();

  async function save() {
    if (sending) return;
    dlg.setBanner('');
    const r = checkGuest(g, ui.today);
    if (!r.ok) {
      if (inputs[r.field]) { setFieldError(inputs[r.field], r.error); inputs[r.field].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      dlg.setBanner(r.error);
      return;
    }
    if (!accepted) { dlg.setBanner('Spunta la conferma che l’ospite ha letto il contratto e l’informativa.'); acceptBox.focus(); return; }
    if (padGuest.isEmpty()) { dlg.setBanner('Manca la firma dell’ospite.'); padGuest.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (padHost.isEmpty()) { dlg.setBanner('Manca la firma del locatore.'); padHost.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (store.pending) {
      store.retry();
      dlg.setBanner('Ci sono ancora modifiche da salvare: aspetta qualche secondo e riprova.');
      return;
    }
    const payload = { booking_id: b.id, accepted: true, lang, guest: r.value, guest_sign: padGuest.toJpeg(), host_sign: padHost.toJpeg() };
    const key = JSON.stringify(payload);
    if (!last || last.key !== key) last = { key, opId: newId(), id: newId() };
    sending = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Salvo…';
    try {
      const res = await store.request('/api/contracts', { method: 'POST', body: { opId: last.opId, payload: { ...payload, id: last.id } } });
      if (res.record) store.accept([['contract', res.record], ...(res.booking ? [['booking', res.booking]] : [])]);
      else await store.load({ force: true });
      sending = 'done';
      dlg.close();
      ctx.toast('Contratto firmato e salvato');
      const c = contractOf(store.data, b.id);
      if (c) openSigned(ctx, c);
    } catch (e) {
      sending = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Firma e salva';
      if (e.code === 'network' || e.status >= 500) dlg.setBanner('Contratto non salvato: connessione assente o lenta. Controlla la rete e premi di nuovo "Firma e salva".');
      else {
        if (e.body?.errors) for (const [k, msg] of Object.entries(e.body.errors)) if (inputs[k]) setFieldError(inputs[k], msg);
        dlg.setBanner(e.message);
        if (e.status === 409) store.load({ force: true });
      }
    }
  }
  return dlg;
}

/* ------------------------------ Contratto firmato ------------------------------ */

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function openSigned(ctx, meta) {
  const { store } = ctx;
  const b = store.data.bookings.find((x) => x.id === meta.booking_id);
  const when = romeDateTime(meta.signed_at);
  const status = h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'Preparo il PDF…' }));
  const shareBtn = h('button', { class: 'btn house', type: 'button', disabled: true, onClick: share }, icon('chat', { size: 16 }), 'Invia su WhatsApp');
  const dlBtn = h('button', { class: 'btn', type: 'button', disabled: true, onClick: () => file && download(file, file.name) }, icon('download', { size: 16 }), 'Scarica PDF');
  const delBtn = isAdmin(ctx) && b && STAGES.includes(b.stage) ? h('button', { class: 'btn ghost danger small', type: 'button', text: 'Elimina per rifarlo', onClick: remove }) : null;
  let file = null;

  const dlg = openDialog({
    title: 'Contratto firmato',
    content: h('div', { class: 'stack' },
      h('div', { class: 'contract-state ok' }, icon('check', { size: 16 }), h('span', { text: `Firmato il ${when.date} alle ${when.time}${meta.lang === 'en' ? ' · in inglese' : ''}${meta.signer_name ? ` · fatto firmare da ${meta.signer_name}` : ''}` })),
      status,
      h('p', { class: 'muted small', text: `Conservato in modo protetto fino al ${formatItDate(meta.purge_after)}, poi cancellato automaticamente.` })),
    actions: [delBtn, dlBtn, shareBtn],
  });

  store.request(`/api/contracts/${encodeURIComponent(meta.id)}`).then((res) => {
    if (dlg.closed) return;
    const c = res.contract;
    file = new File([buildPdf(c)], pdfFileName(c), { type: 'application/pdf' });
    status.replaceChildren(
      h('p', { text: `${c.guest.name} · ${c.house_name} · ${fmtShort(c.check_in)} → ${fmtShort(c.check_out)}` }),
      h('p', { class: 'muted small', text: canShareFile() ? 'Con "Invia su WhatsApp" si apre il menu Condividi: scegli WhatsApp e poi la chat dell’ospite.' : 'Su questo dispositivo il PDF si scarica: poi allegalo nella chat WhatsApp dell’ospite.' }));
    shareBtn.disabled = false;
    dlBtn.disabled = false;
  }).catch((e) => {
    if (dlg.closed) return;
    status.replaceChildren(h('div', { class: 'banner warn', text: e.code === 'network' ? 'Serve la connessione per aprire il contratto firmato.' : e.message }));
  });

  function canShareFile() {
    try {
      return Boolean(file && navigator.canShare && navigator.canShare({ files: [file] }));
    } catch {
      return false;
    }
  }

  async function share() {
    if (!file) return;
    if (canShareFile()) {
      try {
        await navigator.share({ files: [file], title: 'Contratto di locazione' });
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        dlg.setBanner('Non sono riuscito ad aprire il menu Condividi: tocca di nuovo "Invia su WhatsApp" oppure scarica il PDF.');
      }
      return;
    }
    // Computer: si scarica il PDF e si apre la chat (il file va allegato a mano).
    download(file, file.name);
    const n = b && waNumber(b.phone);
    if (n) window.open(`https://wa.me/${n}`, '_blank', 'noopener,noreferrer');
    dlg.setBanner('PDF scaricato: allegalo nella chat WhatsApp dell’ospite.');
  }

  async function remove() {
    const ok = await confirmDialog({ title: 'Eliminare il contratto?', text: 'Testo, dati e firme si cancellano subito e non si possono recuperare. Poi potrai far firmare di nuovo.', okLabel: 'Elimina', danger: true });
    if (!ok) return;
    try {
      await ctx.act('contract.delete', { id: meta.id }, { message: 'Contratto eliminato' });
      dlg.close();
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
  return dlg;
}
