// Scheda della prenotazione e procedure guidate di check-in e check-out.

import { h, icon, newId } from '../dom.js';
import { houseVars, tag, chan, field, setFieldError } from '../ui.js';
import { fmtLong, fmtShort, nights } from '../../shared/dates.js';
import { fmtEuro, parseEuro } from '../../shared/money.js';
import {
  CHANNELS, arrivalReminders, MINORS, SECURITY_STATUS, balanceDue, bookingAlerts, checkinSteps, checkoutSteps,
  missingRequired, nextStep, parseSteps, phase, statusTags, stepLabel,
} from '../../shared/booking.js';
import { openBookingForm } from './form.js';
import { runNextAction, patchSteps, cancelBooking, restoreBooking } from './actions.js';
import { alertActions, waNumber } from './contact.js';

function notFound(ctx) {
  return h('div', { class: 'card' }, h('div', { class: 'empty' },
    h('p', { text: 'Prenotazione non trovata. Forse è stata eliminata o il collegamento non è corretto.' }),
    h('p', null, h('a', { href: '#/prenotazioni', text: 'Torna alle prenotazioni' }))));
}

function backLink(ctx, b) {
  return h('a', { class: 'btn ghost', href: '#/prenotazioni', onClick: () => { ctx.ui.houseId = b.house_id; } }, icon('back'), 'Prenotazioni');
}

export function renderDetail(ctx, id) {
  const { store, ui } = ctx;
  const d = store.data;
  const b = d.bookings.find((x) => x.id === id);
  if (!b) return notFound(ctx);
  const house = d.houses.find((x) => x.id === b.house_id);
  const p = phase(b, ui.today, ctx.clock(b));
  const step = nextStep(b, ui.today, house, ui.now);
  const alerts = bookingAlerts(b, ui.today, d.bookings, ctx.clock(b));
  const n = nights(b.check_in, b.check_out);
  const year = Number(ui.today.slice(0, 4));
  const editable = !['cancellata', 'chiusa'].includes(b.stage);

  const head = h('div', { class: 'detail-head' },
    h('div', { class: 'detail-band' }),
    h('div', { class: 'detail-top' },
      h('div', { class: 'stack' },
        h('div', { class: 'row-sub' }, h('span', { class: 'house-dot' }), house.name, chan(b.channel), h('span', { class: 'tag', text: p.label })),
        h('h1', { text: b.guest_name }),
        h('div', { class: 'muted', text: `${fmtLong(b.check_in, year)} → ${fmtLong(b.check_out, year)} · ${n} ${n === 1 ? 'notte' : 'notti'} · ${b.guests} persone` }),
        h('div', { class: 'tags' }, statusTags(b, ui.today).map(tag))),
      h('div', { class: 'btn-row' },
        editable ? h('button', { class: 'btn', type: 'button', onClick: () => openBookingForm(ctx, { existing: b }) }, icon('edit', { size: 16 }), 'Modifica') : null)));

  const next = step.action || b.stage === 'confermata' ? h('div', { class: ['next-box', step.urgent && 'urgent'] },
    h('div', { class: 'next-label', text: 'Prossimo passo' }),
    h('div', { text: step.text }),
    step.action ? h('button', { class: 'btn house', type: 'button', text: step.label, onClick: () => runNextAction(ctx, b, step.action) }) : null) : null;
  if (next) next.style.marginBottom = '18px';

  // Ogni avviso ha il suo pulsante per sistemarlo subito (chiedere, segnare, completare).
  const alertBox = alerts.length ? h('div', { class: 'card' }, h('div', { class: 'rows' }, alerts.map((a) =>
    h('div', { class: 'row alert-row' }, h('span', { class: ['lvl', a.level] }, icon('alert', { size: 16 })),
      h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: a.text }), alertActions(ctx, b, a)))))) : null;

  // Promemoria per l'arrivo: cosa preparare e cosa incassare.
  const reminders = b.stage === 'confermata' ? panel('Promemoria per l’arrivo',
    h('ul', { class: 'remind' }, arrivalReminders(b, house).map((t) => h('li', { text: t })))) : null;
  if (reminders) reminders.style.marginBottom = '18px';
  if (alertBox) alertBox.style.marginBottom = '18px';

  const due = balanceDue(b);
  const money = [
    ['Totale', b.total_cents ? fmtEuro(b.total_cents) : '—'],
    b.channel === 'diretto' ? ['Acconto', b.deposit_cents ? `${fmtEuro(b.deposit_cents)} · ${b.deposit_paid ? 'ricevuto' : 'non ancora ricevuto'}` : '—'] : ['Pagamento', `tramite ${CHANNELS[b.channel].label}`],
    b.channel === 'diretto' && b.stage === 'confermata' && b.total_cents > 0 ? [b.deposit_paid ? 'Saldo all’arrivo' : 'Ancora da incassare', fmtEuro(due)] : null,
    ['Cauzione', b.security_cents ? `${fmtEuro(b.security_cents)} · ${SECURITY_STATUS[b.security_status].toLowerCase()}` : 'nessuna'],
    b.security_status === 'trattenuta' ? ['Trattenuto', `${fmtEuro(b.security_withheld_cents)} · ${b.security_note || ''}`] : null,
  ].filter(Boolean);

  const phoneDigits = (b.phone || '').replace(/[^\d+]/g, '');
  const wa = waNumber(b.phone);
  const contacts = h('div', { class: 'stack' },
    kv([
      ['Telefono', b.phone || '—'],
      ['Email', b.email || '—'],
      ['Orario di arrivo', b.arrival_time || 'da chiedere'],
    ]),
    b.phone ? h('div', { class: 'btn-row' },
      h('a', { class: 'btn small', href: `tel:${phoneDigits}` }, icon('phone', { size: 16 }), 'Chiama'),
      wa ? h('a', { class: 'btn small', href: `https://wa.me/${wa}`, target: '_blank', rel: 'noopener noreferrer' }, icon('chat', { size: 16 }), 'WhatsApp') : null) : null);

  const details = kv([
    ['Lenzuola', b.linens ? 'sì' : 'no'],
    ['Asciugamani', b.towels ? 'sì' : 'no'],
    ['Delega minorenni', MINORS[b.minors_delegation]],
    b.stage === 'chiusa' ? ['Recensione', b.review_ok ? 'si può chiedere' : 'meglio di no'] : null,
    b.notes ? ['Note della prenotazione', b.notes] : null,
  ].filter(Boolean));

  const flows = [];
  if (b.stage !== 'confermata' && b.stage !== 'cancellata') flows.push(h('a', { class: 'btn small', href: `#/p/${b.id}/checkin`, text: 'Rivedi check-in' }));
  if (b.stage === 'partita' || b.stage === 'chiusa') flows.push(h('a', { class: 'btn small', href: `#/p/${b.id}/checkout`, text: 'Rivedi check-out' }));

  return h('div', { vars: houseVars(house) },
    h('div', { class: 'page-head' }, backLink(ctx, b), ctx.syncChip()),
    head, next, alertBox, reminders,
    h('div', { class: 'grid-2' },
      panel('Soldi', kv(money)),
      panel('Contatti', contacts),
      panel('Dettagli', details),
      panel('Note', notesBlock(ctx, b))),
    h('div', { class: 'section' },
      h('div', { class: 'btn-row' }, flows,
        b.stage === 'cancellata'
          ? h('button', { class: 'btn', type: 'button', text: 'Ripristina prenotazione', onClick: () => restoreBooking(ctx, b) })
          : b.stage !== 'chiusa' ? h('button', { class: 'btn danger', type: 'button', text: 'Cancella prenotazione', onClick: () => cancelBooking(ctx, b) }) : null)),
    historyBlock(ctx, b));
}

function panel(title, content) {
  return h('section', { class: 'card card-pad stack' }, h('h2', { text: title }), content);
}

function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
}

function notesBlock(ctx, b) {
  const { store, ui } = ctx;
  const users = Object.fromEntries(store.data.users.map((u) => [u.email, u.name]));
  const notes = store.data.notes.filter((x) => x.booking_id === b.id);
  const key = `note-${b.id}`;
  const input = h('textarea', { class: 'input', placeholder: 'Scrivi una nota…', maxlength: '1000', dataset: { key },
    attrs: { 'aria-label': 'Nuova nota' }, onInput: (e) => { ui.drafts[key] = e.target.value; } });
  input.value = ui.drafts[key] || '';
  input.style.minHeight = '64px';
  function save() {
    const text = (ui.drafts[key] || '').trim();
    if (!text) { input.focus(); return; }
    const id = newId();
    ui.drafts[key] = '';
    input.value = '';
    ctx.act('note.add', { id, bookingId: b.id, text }, {
      optimistic: (d) => ({ ...d, notes: [...d.notes, { id, booking_id: b.id, text, created_at: new Date().toISOString(), created_by: d.me.email, rev: -1 }] }),
      message: 'Nota salvata',
      undo: () => ctx.act('note.delete', { id }),
    }).catch(() => { ui.drafts[key] = text; ctx.render(); });
  }
  const remove = (note) => ctx.act('note.delete', { id: note.id }, {
    optimistic: (d) => ({ ...d, notes: d.notes.filter((x) => x.id !== note.id) }),
    message: 'Nota eliminata',
    undo: () => ctx.act('note.restore', { id: note.id }),
  }).catch(() => {});
  return h('div', { class: 'stack' },
    notes.length ? notes.map((note) => h('div', { class: 'note' },
      h('div', { class: 'note-text' }, note.text,
        h('div', { class: 'note-meta', text: `${users[note.created_by] || note.created_by || ''} · ${formatWhen(note.created_at)}` })),
      h('button', { class: 'btn ghost icon-only small', type: 'button', onClick: () => remove(note), attrs: { 'aria-label': 'Elimina nota' } }, icon('trash', { size: 16 }))))
      : h('p', { class: 'muted small', text: 'Nessuna nota.' }),
    input,
    h('div', null, h('button', { class: 'btn', type: 'button', text: 'Salva nota', onClick: save })));
}

function formatWhen(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch { return ''; }
}

const ACTIONS = {
  create: 'Prenotazione creata', update: 'Modificata', checkin: 'Check-in concluso', checkout: 'Check-out concluso',
  close: 'Soggiorno chiuso', cancel: 'Cancellata', restore: 'Ripristinata', step_back: 'Tornata alla fase precedente',
  checkin_step: 'Passaggio del check-in', checkout_step: 'Passaggio del check-out', delete: 'Nota eliminata',
};
const FIELDS = {
  guest_name: 'nome', phone: 'telefono', email: 'email', guests: 'persone', check_in: 'arrivo', check_out: 'partenza',
  arrival_time: 'orario di arrivo', total_cents: 'totale', deposit_cents: 'acconto', deposit_paid: 'acconto ricevuto',
  security_cents: 'cauzione', linens: 'lenzuola', towels: 'asciugamani', minors_delegation: 'delega minorenni', notes: 'note',
  channel: 'canale', security_status: 'cauzione', security_withheld_cents: 'trattenuto', review_ok: 'recensione', stage: 'fase',
};

function historyBlock(ctx, b) {
  const { ui, store } = ctx;
  const holder = h('div', { class: 'card card-pad' });
  const cached = ui.history[b.id];
  const stepTitles = Object.fromEntries([...checkinSteps({ ...b, minors_delegation: 'da_chiedere' }), ...checkoutSteps(b)].map((s) => [s.key, s.title]));
  const show = (list) => {
    holder.replaceChildren(list.length ? h('div', null, list.map((x) => {
      let what = x.entity === 'note' ? (x.action === 'create' ? 'Nota aggiunta' : x.action === 'restore' ? 'Nota ripristinata' : 'Nota eliminata') : ACTIONS[x.action] || x.action;
      if (x.action === 'update' && x.changes) what += `: ${Object.keys(x.changes).map((k) => FIELDS[k] || k).join(', ')}`;
      if ((x.action === 'checkin_step' || x.action === 'checkout_step') && x.changes) {
        const [k, v] = Object.entries(x.changes)[0] || [];
        what = `${stepTitles[k] || k}: ${v ? 'fatto' : 'tolto'} (${x.action === 'checkin_step' ? 'check-in' : 'check-out'})`;
      }
      return h('div', { class: 'hist-row' }, h('div', { text: what }), h('div', { class: 'muted tiny', text: `${x.who} · ${formatWhen(x.at)}` }));
    })) : h('p', { class: 'muted', text: 'Nessuna modifica registrata.' }));
  };
  const load = async () => {
    holder.replaceChildren(h('p', { class: 'muted', text: 'Caricamento…' }));
    try {
      const r = await store.request(`/api/bookings/${encodeURIComponent(b.id)}/history`);
      ui.history[b.id] = { rev: b.rev, list: r.history };
      show(r.history);
    } catch (e) {
      holder.replaceChildren(h('p', { class: 'err', text: e.message }));
    }
  };
  const details = h('details', { class: 'section', open: Boolean(cached) },
    h('summary', { class: 'group-title', text: 'Storico delle modifiche' }), holder);
  details.addEventListener('toggle', () => { if (details.open && (!ui.history[b.id] || ui.history[b.id].rev !== b.rev)) load(); });
  if (cached) {
    if (cached.rev === b.rev) show(cached.list); else queueMicrotask(load);
  }
  return details;
}

/* ---------------------------- Procedure guidate ---------------------------- */

export function renderFlow(ctx, id, flow) {
  const { store, ui } = ctx;
  const d = store.data;
  const b = d.bookings.find((x) => x.id === id);
  if (!b) return notFound(ctx);
  const house = d.houses.find((x) => x.id === b.house_id);
  const isIn = flow === 'checkin';
  const steps = isIn ? checkinSteps(b) : checkoutSteps(b);
  const col = isIn ? 'checkin_steps' : 'checkout_steps';
  const done = parseSteps(b[col]);
  const editableStages = isIn ? ['confermata', 'in_casa'] : ['in_casa', 'partita'];
  const canEdit = editableStages.includes(b.stage);
  const finished = isIn ? b.stage !== 'confermata' : ['partita', 'chiusa'].includes(b.stage);
  const effectiveDone = isIn ? done : { ...done, cauzione: done.cauzione || false };
  const missing = missingRequired(steps, effectiveDone);
  const count = steps.filter((s) => effectiveDone[s.key]).length;
  // Scadenza delle 24 ore: ben visibile in cima alla procedura finché il check-in non è completo.
  const deadline = isIn ? bookingAlerts(b, ui.today, [], ctx.clock(b)).find((a) => a.key === 'checkin') : null;

  const toggle = (s) => {
    if (!canEdit) return;
    if (!isIn && s.key === 'cauzione') return;
    const target = !done[s.key];
    ctx.act('booking.step', { id: b.id, flow, step: s.key, done: target }, {
      optimistic: (st) => patchSteps(st, b.id, col, s.key, target ? 1 : 0), quiet: true,
    }).catch(() => {});
  };

  // Cauzione al check-out: scelta esplicita tra restituita e trattenuta.
  const sec = ui.drafts[`sec-${b.id}`] || (ui.drafts[`sec-${b.id}`] = { status: null, amount: '', note: '' });
  const secNeeded = !isIn && b.security_cents > 0 && b.stage === 'in_casa';
  const isSecValid = () => !secNeeded || sec.status === 'restituita'
    || (sec.status === 'trattenuta' && parseEuro(sec.amount) > 0 && parseEuro(sec.amount) <= b.security_cents && Boolean(sec.note.trim()));
  const secValid = isSecValid();
  // Mentre si scrive importo e motivo non si ridisegna niente: si aggiornano solo pulsante e spiegazione.
  let finishBtn = null;
  let finishHint = null;
  let secNum = null;
  const updateFinish = () => {
    const ok = isSecValid();
    const readyNow = missing.filter((s) => s.key !== 'cauzione').length === 0 && ok;
    if (finishBtn) finishBtn.disabled = !readyNow;
    if (finishHint) {
      finishHint.hidden = readyNow;
      if (!readyNow && missing.every((s) => s.key === 'cauzione')) finishHint.textContent = 'Indica cosa fare della cauzione.';
    }
    if (secNum) {
      secNum.closest('.flow-step').classList.toggle('done', ok && Boolean(sec.status));
      secNum.replaceChildren(ok && sec.status ? icon('check', { size: 16 }) : String(secNum.dataset.n));
    }
  };

  const rows = steps.map((s, i) => {
    const isDone = !isIn && s.key === 'cauzione' ? (finished ? true : Boolean(secNeeded && secValid && sec.status)) : Boolean(effectiveDone[s.key]);
    const content = [
      h('span', { class: 'flow-num' }, isDone ? icon('check', { size: 16 }) : String(i + 1)),
      h('span', { class: 'row-main' },
        h('span', { class: 'flow-title' }, s.title, s.required ? null : h('span', { class: 'opt', text: 'facoltativo' })),
        h('span', { class: 'flow-help', text: s.help }),
        // Dentro un pulsante si usano solo elementi "in linea": niente elenchi veri.
        s.reminders ? h('span', { class: 'remind' }, arrivalReminders(b, house).map((t) => h('span', { text: `• ${t}` }))) : null),
    ];
    if (!isIn && s.key === 'cauzione') {
      secNum = content[0];
      secNum.dataset.n = String(i + 1);
      return h('div', { class: ['flow-step', isDone && 'done'] }, content[0],
        h('div', { class: 'row-main stack' }, content[1], secNeeded ? securityChoice(ctx, b, sec, updateFinish) : h('span', { class: 'muted small', text: b.security_cents ? `${SECURITY_STATUS[b.security_status]}${b.security_status === 'trattenuta' ? `: ${fmtEuro(b.security_withheld_cents)} (${b.security_note})` : ''}` : 'Nessuna cauzione per questa prenotazione.' })));
    }
    return h('button', { class: ['flow-step', isDone && 'done'], type: 'button', disabled: !canEdit,
      attrs: { 'aria-pressed': String(isDone) }, onClick: () => toggle(s) }, content);
  });

  const missingNow = missing.filter((s) => !(s.key === 'cauzione'));
  const ready = missingNow.length === 0 && secValid;
  const finishLabel = isIn ? 'Concludi check-in' : 'Concludi check-out';

  async function finish() {
    if (!isSecValid()) return;
    const cur = store.data.bookings.find((x) => x.id === b.id);
    try {
      if (isIn) {
        await ctx.act('booking.checkin', { id: b.id, version: cur.version }, {
          message: `Check-in concluso: ${house.name} ora risulta in casa`,
          undo: (r) => ctx.act('booking.step_back', { id: b.id, version: r.record.version }, { message: 'Check-in annullato' }),
        });
      } else {
        const security = secNeeded ? { status: sec.status, withheld_cents: sec.status === 'trattenuta' ? parseEuro(sec.amount) : 0, note: sec.note } : undefined;
        await ctx.act('booking.checkout', { id: b.id, version: cur.version, security }, {
          message: 'Check-out concluso',
          undo: (r) => ctx.act('booking.step_back', { id: b.id, version: r.record.version }, { message: 'Check-out annullato' }),
        });
        delete ui.drafts[`sec-${b.id}`];
      }
      ctx.go('oggi');
    } catch { /* il messaggio d'errore è già mostrato */ }
  }

  let footer;
  if (finished) {
    const left = isIn && b.stage === 'in_casa' ? missing : [];
    footer = left.length
      ? h('div', { class: 'banner bad', text: `Check-in incompleto. Spunta qui sopra: ${left.map(stepLabel).join(', ')}.` })
      : h('div', { class: 'banner', text: isIn ? 'Check-in concluso.' : 'Check-out concluso.' });
  } else if (!canEdit) {
    footer = h('div', { class: 'banner warn', text: isIn ? 'Il check-in non è possibile in questa fase.' : 'Il check-out si fa dopo il check-in.' });
  } else {
    finishBtn = h('button', { class: 'btn house', type: 'button', disabled: !ready, text: finishLabel, onClick: finish });
    finishHint = h('span', { class: 'muted small', hidden: ready, text: missingNow.length ? `Mancano: ${missingNow.map(stepLabel).join(', ')}.` : 'Indica cosa fare della cauzione.' });
    footer = h('div', { class: 'btn-row' }, finishBtn, finishHint);
  }

  return h('div', { vars: houseVars(house) },
    h('div', { class: 'page-head' },
      h('a', { class: 'btn ghost', href: `#/p/${b.id}` }, icon('back'), 'Scheda prenotazione'),
      ctx.syncChip()),
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { text: `${isIn ? 'Check-in' : 'Check-out'} · ${house.name}` }),
        h('div', { class: 'sub', text: `${b.guest_name} · ${b.guests} persone · ${isIn ? `arrivo ${fmtShort(b.check_in)}${b.arrival_time ? ` alle ${b.arrival_time}` : ''}` : `partenza ${fmtShort(b.check_out)} entro le ${house.checkout_time}`}` })),
      h('span', { class: 'progress', text: `${count} di ${steps.length} fatti` })),
    deadline ? h('div', { class: ['banner', deadline.level === 'urgente' ? 'bad' : 'warn'], text: deadline.text, attrs: { role: 'status' } }) : null,
    h('div', { class: 'card' }, rows),
    h('div', { class: 'section' }, footer));
}

function securityChoice(ctx, b, sec, onChange) {
  const k = (s) => `sec-${s}-${b.id}`;
  const amountProblem = () => (sec.amount && (parseEuro(sec.amount) === null || parseEuro(sec.amount) <= 0 || parseEuro(sec.amount) > b.security_cents)
    ? `Scrivi un importo fino a ${fmtEuro(b.security_cents)}` : '');
  const amount = h('input', { class: 'input', inputmode: 'decimal', placeholder: '0', value: sec.amount, dataset: { key: k('amount') },
    onInput: (e) => { sec.amount = e.target.value; setFieldError(amount, amountProblem()); onChange(); } });
  const note = h('input', { class: 'input', type: 'text', maxlength: '300', placeholder: 'Es. bicchieri rotti', value: sec.note, dataset: { key: k('note') },
    onInput: (e) => { sec.note = e.target.value; onChange(); } });
  const choose = (status) => { sec.status = status; ctx.render(); };
  return h('div', { class: 'stack' },
    h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Cauzione' } },
      h('button', { type: 'button', attrs: { 'aria-pressed': String(sec.status === 'restituita') }, onClick: () => choose('restituita') }, 'Restituita tutta'),
      h('button', { type: 'button', attrs: { 'aria-pressed': String(sec.status === 'trattenuta') }, onClick: () => choose('trattenuta') }, 'Ne trattengo una parte')),
    sec.status === 'trattenuta' ? h('div', { class: 'form-grid' },
      field('Quanto trattieni (€)', amount, { error: amountProblem() || null }),
      field('Motivo', note)) : null);
}
