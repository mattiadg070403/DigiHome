// Modulo nuova prenotazione / modifica prenotazione.
// - Si chiude solo con X o Annulla; se ci sono dati non salvati chiede conferma.
// - Mentre si scrive, tutto viene salvato come bozza sul dispositivo (si riprende dopo una ricarica).
// - Calendario stile Airbnb con notti occupate bloccate, date anche scrivibili a mano.

import { h } from '../dom.js';
import { openDialog, field, setFieldError, switchRow, segmented, houseVars, confirmDialog } from '../ui.js';
import { dateRangeField, timeField } from '../pickers.js';
import { readDraft, writeDraft, clearDraft } from '../drafts.js';
import { fmtShort, isIsoDate, nights } from '../../shared/dates.js';
import { fmtEuro, parseEuro, centsToInput } from '../../shared/money.js';
import { CHANNELS, MINORS, validateBooking, balanceDue, occupiedNights } from '../../shared/booking.js';

const MONEY = ['total_cents', 'deposit_cents', 'security_cents'];

const EMPTY = (houseId) => ({
  house_id: houseId, channel: 'diretto', guest_name: '', phone: '', email: '', guests: 2,
  check_in: '', check_out: '', arrival_time: '', total_cents: 0, deposit_cents: 0, deposit_paid: 0, security_cents: 0,
  linens: 1, towels: 0, minors_delegation: 'non_serve', notes: '',
});

/**
 * Apre il modulo.
 * - `existing`: prenotazione da modificare (altrimenti nuova).
 * - `preset`: valori iniziali per una nuova (es. data di arrivo toccata nel calendario).
 * - `focus`: nome del campo da evidenziare all'apertura (es. 'phone').
 */
export function openBookingForm(ctx, { existing = null, preset = {}, focus = null } = {}) {
  const { store, ui } = ctx;
  const d = store.data;
  const isNew = !existing;
  let base = existing ? { ...existing } : null;
  let v = existing ? { ...existing } : { ...EMPTY(preset.house_id || ui.houseId), ...('check_in' in preset ? { check_in: preset.check_in } : {}) };

  // Bozza rimasta da prima (ricarica, scheda chiusa, uscita per sbaglio)?
  const draft = readDraft();
  let restored = false;
  if (draft && ((isNew && draft.mode === 'new' && !preset.check_in) || (!isNew && draft.mode === 'edit' && draft.id === existing.id))) {
    v = { ...v, ...draft.v };
    restored = true;
  }
  let dirty = restored;

  const house = () => d.houses.find((x) => x.id === v.house_id) || d.houses[0];
  const controls = {};
  const box = h('div', { class: 'stack' });
  const summary = h('div', { class: 'summary', attrs: { 'aria-live': 'polite' } });
  let range = null;
  let guestsErr = null;
  let timeOk = true;

  let draftTimer = null;
  function changed() {
    dirty = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      writeDraft(isNew ? { mode: 'new', v } : { mode: 'edit', id: existing.id, version: base.version, v });
    }, 250);
    refresh();
  }

  function input(name, attrs = {}) {
    const el = h('input', { class: 'input', name, value: v[name] ?? '', ...attrs,
      onInput: (e) => { v[name] = e.target.value; setFieldError(el, ''); changed(); } });
    controls[name] = el;
    return el;
  }
  function money(name) {
    const el = h('input', { class: 'input', name, inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: centsToInput(v[name]),
      onInput: (e) => {
        const c = parseEuro(e.target.value);
        setFieldError(el, c === null ? 'Importo non valido' : '');
        if (c !== null) v[name] = c;
        changed();
      } });
    controls[name] = el;
    return el;
  }

  function guestsControl() {
    const h0 = house();
    const err = h('div', { class: 'err', hidden: true, attrs: { role: 'alert' } });
    const num = h('input', { class: 'input', name: 'guests', type: 'text', inputmode: 'numeric', autocomplete: 'off', value: String(v.guests ?? ''),
      attrs: { 'aria-label': 'Numero di persone' },
      onInput: (e) => { const n = parseInt(e.target.value.replace(/\D/g, ''), 10); v.guests = Number.isFinite(n) ? n : ''; check(); changed(); } });
    controls.guests = num;
    const set = (n) => { v.guests = Math.max(1, n); num.value = String(v.guests); check(); changed(); };
    const minus = h('button', { class: 'btn', type: 'button', text: '−', attrs: { 'aria-label': 'Una persona in meno' }, onClick: () => set((Number(v.guests) || 1) - 1) });
    const plus = h('button', { class: 'btn', type: 'button', text: '+', attrs: { 'aria-label': 'Una persona in più' }, onClick: () => set((Number(v.guests) || 0) + 1) });
    function check() {
      const n = Number(v.guests);
      let msg = '';
      if (!Number.isInteger(n) || n < 1) msg = 'Indica quante persone.';
      else if (n > h0.max_guests) msg = `Troppe persone: ${h0.name} ne ospita al massimo ${h0.max_guests}.`;
      err.textContent = msg;
      err.hidden = !msg;
      num.setAttribute('aria-invalid', String(Boolean(msg)));
      guestsErr = msg || null;
    }
    check();
    return h('div', { class: 'field' },
      h('div', { class: 'label', text: 'Persone' }),
      h('div', { class: 'stepper' }, minus, num, plus),
      h('div', { class: 'hint', text: `Massimo ${h0.max_guests} a ${h0.name}` }),
      err);
  }

  function build() {
    const h0 = house();
    const occupied = occupiedNights(store.data.bookings, v.house_id, existing ? existing.id : null);
    range = dateRangeField({
      checkIn: v.check_in, checkOut: v.check_out, occupied, today: ui.today,
      onChange: (ci, co) => {
        const was = `${v.check_in}|${v.check_out}`;
        v.check_in = ci || '';
        v.check_out = co || '';
        if (`${v.check_in}|${v.check_out}` !== was) changed(); else refresh();
      },
    });
    const time = timeField({ value: v.arrival_time || '', label: 'Orario di arrivo', onChange: (t) => {
      timeOk = t !== null;
      if (t !== null) v.arrival_time = t;
      changed();
    } });
    controls.arrival_time = time.input;

    const houseSeg = isNew ? h('div', { class: 'field full' }, h('div', { class: 'label', text: 'Casa' }),
      segmented(d.houses.map((x) => ({ value: x.id, label: x.name, swatch: true, vars: houseVars(x) })), v.house_id,
        (id) => { v.house_id = id; changed(); build(); }, 'Casa')) : null;
    const channelSeg = h('div', { class: 'field full' }, h('div', { class: 'label', text: 'Canale' }),
      segmented(Object.entries(CHANNELS).map(([k, c]) => ({ value: k, label: c.label })), v.channel, (c) => { v.channel = c; changed(); build(); }, 'Canale'));

    const minors = h('select', { class: 'input', name: 'minors_delegation', onChange: (e) => { v.minors_delegation = e.target.value; changed(); } },
      Object.entries(MINORS).map(([k, label]) => h('option', { value: k, text: label, selected: v.minors_delegation === k })));
    controls.minors_delegation = minors;
    const notes = h('textarea', { class: 'input', name: 'notes', maxlength: '2000', onInput: (e) => { v.notes = e.target.value; changed(); } });
    notes.value = v.notes || '';

    const direct = v.channel === 'diretto';
    // Arrivata dal calendario di Airbnb/Booking: il canale resta quello, le date le aggiorna il calendario.
    const linked = Boolean(existing && existing.ext_uid);
    const linkedNote = linked ? h('div', { class: 'banner full', text: existing.needs_details
      ? `Arrivata dal calendario ${CHANNELS[v.channel].label}: completa nome, persone e telefono. Le date si aggiornano da sole dal calendario.`
      : `Collegata al calendario ${CHANNELS[v.channel].label}: se cambi le date qui, al prossimo aggiornamento tornano quelle di ${CHANNELS[v.channel].label}.` }) : null;
    box.replaceChildren(
      h('div', { class: 'form-grid' },
        linkedNote,
        houseSeg,
        linked ? null : channelSeg,
        field('Nome dell’ospite o del gruppo', input('guest_name', { type: 'text', maxlength: '120', autocomplete: 'off' }), { full: true }),
        h('div', { class: 'field full', vars: houseVars(h0) }, h('div', { class: 'label', text: 'Date del soggiorno' }), range.el),
        guestsControl(),
        h('div', { class: 'field' }, h('div', { class: 'label', text: 'Orario di arrivo (se lo sai già)' }), time.el),
        field('Telefono', input('phone', { type: 'tel', autocomplete: 'off', maxlength: '40' })),
        field('Email', input('email', { type: 'email', autocomplete: 'off', maxlength: '160' })),
      ),
      h('h3', { text: 'Soldi' }),
      h('div', { class: 'form-grid' },
        field(direct ? 'Prezzo totale del soggiorno (€)' : `Totale pagato su ${CHANNELS[v.channel].label} (€)`, money('total_cents')),
        direct ? field('Acconto (€)', money('deposit_cents')) : h('div'),
        direct ? h('div', { class: 'full' }, switchRow('Acconto già ricevuto', { checked: Boolean(v.deposit_paid), onChange: (c) => { v.deposit_paid = c ? 1 : 0; changed(); } })) : null,
        field('Cauzione (€)', money('security_cents'), { hint: 'Lascia vuoto se non la chiedi' }),
      ),
      summary,
      h('h3', { text: 'Dettagli' }),
      h('div', { class: 'form-grid' },
        h('div', null, switchRow('Lenzuola', { checked: Boolean(v.linens), onChange: (c) => { v.linens = c ? 1 : 0; changed(); } })),
        h('div', null, switchRow('Asciugamani', { checked: Boolean(v.towels), onChange: (c) => { v.towels = c ? 1 : 0; changed(); } })),
        field('Delega per minorenni', minors, { hint: 'Serve se ci sono minorenni senza un genitore' }),
        field('Note', notes, { full: true }),
      ),
    );
    refresh();
  }

  function refresh() {
    const n = isIsoDate(v.check_in) && isIsoDate(v.check_out) && v.check_out > v.check_in ? nights(v.check_in, v.check_out) : 0;
    const parts = [];
    if (n) parts.push(h('span', null, h('strong', { text: `${n} ${n === 1 ? 'notte' : 'notti'}` }), ` · ${fmtShort(v.check_in)} → ${fmtShort(v.check_out)}`));
    if (v.channel === 'diretto' && v.total_cents > 0) parts.push(h('span', { text: `${v.deposit_paid ? 'Saldo all’arrivo' : 'Ancora da incassare'}: ${fmtEuro(balanceDue(v))}` }));
    if (n && v.total_cents > 0) parts.push(h('span', { class: 'muted', text: `${fmtEuro(Math.round(v.total_cents / n))} a notte` }));
    summary.replaceChildren(...(parts.length ? parts : [h('span', { class: 'muted', text: 'Scegli le date per vedere il riepilogo.' })]));
  }

  function payload() {
    return {
      channel: v.channel, guest_name: v.guest_name, phone: v.phone, email: v.email, guests: Number(v.guests),
      check_in: v.check_in, check_out: v.check_out, arrival_time: v.arrival_time || '',
      total_cents: v.total_cents || 0, security_cents: v.security_cents || 0,
      deposit_cents: v.channel === 'diretto' ? v.deposit_cents || 0 : 0,
      deposit_paid: v.channel === 'diretto' ? Boolean(v.deposit_paid) : false,
      linens: Boolean(v.linens), towels: Boolean(v.towels), minors_delegation: v.minors_delegation, notes: v.notes,
    };
  }

  function showErrors(errors) {
    let first = null;
    for (const [k, msg] of Object.entries(errors || {})) {
      if (k === 'check_in' || k === 'check_out') { first = first || range; continue; }
      if (k === 'guests') { first = first || controls.guests; continue; }
      const el = controls[k];
      if (el) { setFieldError(el, msg); first = first || el; }
    }
    if (first) first.focus();
  }

  const saveBtn = h('button', { class: 'btn primary', type: 'button', text: isNew ? 'Salva prenotazione' : 'Salva modifiche', onClick: save });
  const cancelBtn = h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.requestClose() });
  const dlg = openDialog({
    title: isNew ? 'Nuova prenotazione' : 'Modifica prenotazione',
    content: box,
    actions: [cancelBtn, saveBtn],
    onClose: () => { unsubscribe(); ctx.render(); },
    canClose: async () => {
      if (!dirty) { clearDraft(); return true; }
      const leave = await confirmDialog({
        title: 'Uscire senza salvare?',
        text: 'Quello che hai scritto resta salvato come bozza su questo dispositivo: la ritrovi la prossima volta che apri il modulo.',
        okLabel: 'Esci', danger: false,
      });
      return leave;
    },
  });

  if (restored) {
    dlg.setBanner(isNew ? 'Ho ripreso la prenotazione che stavi scrivendo.' : 'Ho ripreso le modifiche che non avevi salvato.',
      h('button', { class: 'btn small', type: 'button', text: isNew ? 'Ricomincia da zero' : 'Annulla le modifiche', onClick: () => {
        clearDraft();
        v = existing ? { ...existing } : EMPTY(ui.houseId);
        dirty = false;
        dlg.setBanner('');
        build();
      } }));
  }

  // Se mentre il modulo è aperto qualcuno modifica la stessa prenotazione, lo diciamo subito.
  const unsubscribe = store.subscribe((kind) => {
    if (kind !== 'data' || dlg.closed) return;
    if (range) range.refreshOccupied(occupiedNights(store.data.bookings, v.house_id, existing ? existing.id : null));
    if (isNew) return;
    const now = store.data.bookings.find((x) => x.id === existing.id);
    if (now && base && now.version !== base.version) {
      dlg.setBanner('Questa prenotazione è stata appena modificata da un altro dispositivo.',
        h('button', { class: 'btn small', type: 'button', text: 'Carica i dati aggiornati', onClick: () => {
          base = { ...now };
          v = { ...now };
          dirty = false;
          clearDraft();
          dlg.setBanner('');
          build();
        } }));
    }
  });

  let saving = false;
  async function save() {
    if (saving) return;
    for (const k of MONEY) {
      if (controls[k] && parseEuro(controls[k].value) === null) { controls[k].focus(); return; }
    }
    if (!range.valid) { dlg.setBanner(range.problem); range.focus(); return; }
    if (guestsErr) { dlg.setBanner(guestsErr); controls.guests.focus(); return; }
    if (!timeOk) { dlg.setBanner('Orario di arrivo non valido (es. 16:30).'); controls.arrival_time.focus(); return; }
    const p = payload();
    const check = validateBooking({ ...p, house_id: v.house_id }, { house: house(), partial: !isNew });
    if (!check.ok) { dlg.setBanner('Controlla i campi evidenziati.'); showErrors(check.errors); return; }
    dlg.setBanner('');
    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Salvataggio…';
    try {
      if (isNew) {
        const res = await ctx.act('booking.create', { booking: { ...p, house_id: v.house_id } }, {
          message: 'Prenotazione salvata',
          undo: (r) => ctx.act('booking.cancel', { id: r.record.id, version: r.record.version }, { message: 'Prenotazione annullata' }),
        });
        clearTimeout(draftTimer);
        clearDraft();
        dirty = false;
        dlg.close();
        ctx.go(`p/${res.record.id}`);
      } else {
        const changes = {};
        for (const [k, val] of Object.entries(p)) {
          const before = typeof base[k] === 'number' && typeof val === 'boolean' ? Boolean(base[k]) : base[k] ?? (typeof val === 'string' ? '' : base[k]);
          if (before !== val && !(before == null && val === '')) changes[k] = val;
        }
        clearTimeout(draftTimer);
        // Prenotazione arrivata dal calendario: salvare conferma che i dati sono completi, anche senza cambiamenti.
        if (!Object.keys(changes).length && !base.needs_details) { clearDraft(); dirty = false; dlg.close(); return; }
        const old = Object.fromEntries(Object.keys(changes).map((k) => [k, base[k]]));
        await ctx.act('booking.update', { id: existing.id, version: base.version, changes }, {
          message: 'Modifiche salvate',
          undo: (r) => ctx.act('booking.update', { id: existing.id, version: r.record.version, changes: old }, { message: 'Modifiche annullate' }),
        });
        clearDraft();
        dirty = false;
        dlg.close();
      }
    } catch (e) {
      if (e.body && e.body.errors) showErrors(e.body.errors);
      dlg.setBanner(e.message);
      if (e.code === 'conflict' && e.body.current) {
        dlg.setBanner(e.message, h('button', { class: 'btn small', type: 'button', text: 'Carica i dati aggiornati', onClick: () => {
          base = { ...e.body.current };
          v = { ...e.body.current };
          dirty = false;
          clearDraft();
          dlg.setBanner('');
          build();
        } }));
      }
    } finally {
      saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = isNew ? 'Salva prenotazione' : 'Salva modifiche';
    }
  }

  build();
  if (focus && controls[focus]) setTimeout(() => controls[focus].focus(), 50);
  return dlg;
}

/** Avviso "Prenotazione non salvata" da mostrare in Oggi e Prenotazioni (null se non c'è bozza). */
export function draftBanner(ctx) {
  const draft = readDraft();
  if (!draft) return null;
  const existing = draft.mode === 'edit' ? ctx.store.data.bookings.find((b) => b.id === draft.id) : null;
  if (draft.mode === 'edit' && !existing) { clearDraft(); return null; }
  const house = ctx.store.data.houses.find((x) => x.id === draft.v.house_id);
  const name = (draft.v.guest_name || '').trim() || 'senza nome';
  return h('div', { class: 'banner warn', attrs: { role: 'status' } },
    h('span', { text: `${draft.mode === 'edit' ? 'Modifiche non salvate' : 'Prenotazione non salvata'}: ${name}${house ? ` · ${house.name}` : ''}` }),
    h('button', { class: 'btn small', type: 'button', text: 'Riprendi', onClick: () => openBookingForm(ctx, { existing }) }),
    h('button', { class: 'btn small ghost', type: 'button', text: 'Elimina la bozza', onClick: async () => {
      const ok = await confirmDialog({ title: 'Eliminare la bozza?', text: 'Quello che avevi scritto verrà cancellato da questo dispositivo.', okLabel: 'Elimina', danger: true });
      if (ok) { clearDraft(); ctx.render(); }
    } }));
}
