// Modulo nuova prenotazione / modifica prenotazione.

import { h } from '../dom.js';
import { openDialog, field, setFieldError, switchRow, segmented, houseVars } from '../ui.js';
import { addDays, fmtShort, isIsoDate, nights, overlaps } from '../../shared/dates.js';
import { fmtEuro, parseEuro, centsToInput } from '../../shared/money.js';
import { CHANNELS, MINORS, validateBooking, balanceDue } from '../../shared/booking.js';

const MONEY = ['total_cents', 'deposit_cents', 'security_cents'];

/**
 * Apre il modulo. `existing`: prenotazione da modificare (altrimenti nuova).
 * `preset`: valori iniziali per una nuova (es. data scelta dal calendario).
 */
export function openBookingForm(ctx, { existing = null, preset = {} } = {}) {
  const { store, ui } = ctx;
  const d = store.data;
  const isNew = !existing;
  let base = existing ? { ...existing } : null;
  const v = existing ? { ...existing } : {
    house_id: preset.house_id || ui.houseId, channel: 'diretto', guest_name: '', phone: '', email: '', guests: 2,
    check_in: preset.check_in || '', check_out: preset.check_out || (preset.check_in ? addDays(preset.check_in, 7) : ''),
    arrival_time: '', total_cents: 0, deposit_cents: 0, deposit_paid: 0, security_cents: 0,
    linens: 1, towels: 0, minors_delegation: 'non_serve', notes: '',
  };
  const house = () => d.houses.find((x) => x.id === v.house_id) || d.houses[0];
  const controls = {};
  const box = h('div', { class: 'stack' });
  const summary = h('div', { class: 'summary', attrs: { 'aria-live': 'polite' } });
  const clashBox = h('div', { class: 'banner bad', hidden: true, attrs: { role: 'alert' } });

  function input(name, attrs = {}) {
    const el = h('input', { class: 'input', name, value: v[name] ?? '', ...attrs,
      onInput: (e) => { v[name] = e.target.value; setFieldError(el, ''); refresh(); } });
    controls[name] = el;
    return el;
  }
  function money(name) {
    const el = h('input', { class: 'input', name, inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: centsToInput(v[name]),
      onInput: (e) => {
        const c = parseEuro(e.target.value);
        setFieldError(el, c === null ? 'Importo non valido' : '');
        if (c !== null) v[name] = c;
        refresh();
      } });
    controls[name] = el;
    return el;
  }

  function build() {
    const h0 = house();
    const houseSeg = isNew ? field('Casa', segmented(d.houses.map((x) => ({ value: x.id, label: x.name, swatch: true, vars: houseVars(x) })), v.house_id,
      (id) => { v.house_id = id; rebuild(); }, 'Casa'), { full: true }) : null;
    const channelSeg = h('div', { class: 'field full' }, h('div', { class: 'label', text: 'Canale' }),
      segmented(Object.entries(CHANNELS).map(([k, c]) => ({ value: k, label: c.label })), v.channel, (c) => { v.channel = c; rebuild(); }, 'Canale'));

    const guests = input('guests', { type: 'number', min: '1', max: String(h0.max_guests), inputmode: 'numeric' });
    const minors = h('select', { class: 'input', name: 'minors_delegation', onChange: (e) => { v.minors_delegation = e.target.value; } },
      Object.entries(MINORS).map(([k, label]) => h('option', { value: k, text: label, selected: v.minors_delegation === k })));
    controls.minors_delegation = minors;
    const notes = h('textarea', { class: 'input', name: 'notes', maxlength: '2000', onInput: (e) => { v.notes = e.target.value; } });
    notes.value = v.notes || '';

    const direct = v.channel === 'diretto';
    box.replaceChildren(
      h('div', { class: 'form-grid' },
        houseSeg,
        channelSeg,
        field('Nome dell’ospite o del gruppo', input('guest_name', { type: 'text', maxlength: '120', autocomplete: 'off' }), { full: true }),
        field('Arrivo', input('check_in', { type: 'date' })),
        field('Partenza', input('check_out', { type: 'date' })),
        field('Persone', guests, { hint: `Massimo ${h0.max_guests} a ${h0.name}` }),
        field('Orario di arrivo', input('arrival_time', { type: 'time', step: '300' }), { hint: 'Se lo sai già' }),
        field('Telefono', input('phone', { type: 'tel', autocomplete: 'off', maxlength: '40' })),
        field('Email', input('email', { type: 'email', autocomplete: 'off', maxlength: '160' })),
      ),
      clashBox,
      h('h3', { text: 'Soldi' }),
      h('div', { class: 'form-grid' },
        field(direct ? 'Prezzo totale del soggiorno (€)' : `Totale pagato su ${CHANNELS[v.channel].label} (€)`, money('total_cents')),
        direct ? field('Acconto (€)', money('deposit_cents')) : h('div'),
        direct ? h('div', { class: 'full' }, switchRow('Acconto già ricevuto', { checked: Boolean(v.deposit_paid), onChange: (c) => { v.deposit_paid = c ? 1 : 0; refresh(); } })) : null,
        field('Cauzione (€)', money('security_cents'), { hint: 'Lascia vuoto se non la chiedi' }),
      ),
      summary,
      h('h3', { text: 'Dettagli' }),
      h('div', { class: 'form-grid' },
        h('div', null, switchRow('Lenzuola', { checked: Boolean(v.linens), onChange: (c) => { v.linens = c ? 1 : 0; } })),
        h('div', null, switchRow('Asciugamani', { checked: Boolean(v.towels), onChange: (c) => { v.towels = c ? 1 : 0; } })),
        field('Delega per minorenni', minors, { hint: 'Serve se ci sono minorenni senza un genitore' }),
        field('Note', notes, { full: true }),
      ),
    );
    refresh();
  }

  function rebuild() {
    // Mantiene i valori già scritti: sono in `v`.
    build();
  }

  function refresh() {
    const n = isIsoDate(v.check_in) && isIsoDate(v.check_out) && v.check_out > v.check_in ? nights(v.check_in, v.check_out) : 0;
    const parts = [];
    if (n) parts.push(h('span', null, h('strong', { text: `${n} ${n === 1 ? 'notte' : 'notti'}` }), ` · ${fmtShort(v.check_in)} → ${fmtShort(v.check_out)}`));
    if (v.channel === 'diretto' && v.total_cents > 0) parts.push(h('span', { text: `${v.deposit_paid ? 'Saldo all’arrivo' : 'Ancora da incassare'}: ${fmtEuro(balanceDue(v))}` }));
    if (n && v.total_cents > 0) parts.push(h('span', { class: 'muted', text: `${fmtEuro(Math.round(v.total_cents / n))} a notte` }));
    summary.replaceChildren(...(parts.length ? parts : [h('span', { class: 'muted', text: 'Scegli le date per vedere il riepilogo.' })]));

    const clash = n ? store.data.bookings.find((o) => o.id !== v.id && o.house_id === v.house_id && o.stage !== 'cancellata'
      && overlaps(v.check_in, v.check_out, o.check_in, o.check_out)) : null;
    clashBox.hidden = !clash;
    clashBox.replaceChildren(clash ? h('span', { text: `Date occupate: c’è già ${clash.guest_name} dal ${fmtShort(clash.check_in)} al ${fmtShort(clash.check_out)}.` }) : '');
  }

  function payload() {
    const out = {
      channel: v.channel, guest_name: v.guest_name, phone: v.phone, email: v.email, guests: Number(v.guests),
      check_in: v.check_in, check_out: v.check_out, arrival_time: v.arrival_time,
      total_cents: v.total_cents || 0, security_cents: v.security_cents || 0,
      deposit_cents: v.channel === 'diretto' ? v.deposit_cents || 0 : 0,
      deposit_paid: v.channel === 'diretto' ? Boolean(v.deposit_paid) : false,
      linens: Boolean(v.linens), towels: Boolean(v.towels), minors_delegation: v.minors_delegation, notes: v.notes,
    };
    return out;
  }

  function showErrors(errors) {
    let first = null;
    for (const [k, msg] of Object.entries(errors || {})) {
      const el = controls[k];
      if (el) { setFieldError(el, msg); first = first || el; }
    }
    if (first) first.focus();
  }

  const saveBtn = h('button', { class: 'btn primary', type: 'button', text: isNew ? 'Salva prenotazione' : 'Salva modifiche', onClick: save });
  const dlg = openDialog({
    title: isNew ? 'Nuova prenotazione' : 'Modifica prenotazione',
    content: box,
    actions: [h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }), saveBtn],
    onClose: () => unsubscribe(),
  });

  // Se mentre il modulo è aperto qualcuno modifica la stessa prenotazione, lo diciamo subito.
  const unsubscribe = store.subscribe((kind) => {
    if (kind !== 'data' || isNew || dlg.closed) return;
    const now = store.data.bookings.find((x) => x.id === existing.id);
    if (now && base && now.version !== base.version) {
      dlg.setBanner('Questa prenotazione è stata appena modificata da un altro dispositivo.',
        h('button', { class: 'btn small', type: 'button', text: 'Carica i dati aggiornati', onClick: () => {
          base = { ...now };
          Object.assign(v, now);
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
    const p = payload();
    const check = validateBooking({ ...p, house_id: v.house_id }, { house: house(), partial: !isNew });
    if (!check.ok) { showErrors(check.errors); return; }
    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Salvataggio…';
    try {
      if (isNew) {
        const res = await ctx.act('booking.create', { booking: { ...p, house_id: v.house_id } }, {
          message: 'Prenotazione salvata',
          undo: (r) => ctx.act('booking.cancel', { id: r.record.id, version: r.record.version }, { message: 'Prenotazione annullata' }),
        });
        dlg.close();
        ctx.go(`p/${res.record.id}`);
      } else {
        const changes = {};
        for (const [k, val] of Object.entries(p)) {
          const before = typeof base[k] === 'number' && typeof val === 'boolean' ? Boolean(base[k]) : base[k] ?? (typeof val === 'string' ? '' : base[k]);
          if (before !== val && !(before == null && val === '')) changes[k] = val;
        }
        if (!Object.keys(changes).length) { dlg.close(); return; }
        const old = Object.fromEntries(Object.keys(changes).map((k) => [k, base[k]]));
        await ctx.act('booking.update', { id: existing.id, version: base.version, changes }, {
          message: 'Modifiche salvate',
          undo: (r) => ctx.act('booking.update', { id: existing.id, version: r.record.version, changes: old }, { message: 'Modifiche annullate' }),
        });
        dlg.close();
      }
    } catch (e) {
      if (e.body && e.body.errors) showErrors(e.body.errors);
      dlg.setBanner(e.message);
      if (e.code === 'conflict' && e.body.current) {
        dlg.setBanner(e.message, h('button', { class: 'btn small', type: 'button', text: 'Carica i dati aggiornati', onClick: () => {
          base = { ...e.body.current };
          Object.assign(v, e.body.current);
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
  return dlg;
}
