// Impostazioni: account, utenti e case (solo amministratore), dati di prova.

import { h, icon } from '../dom.js';
import { houseVars, field, openDialog, confirmDialog, switchRow, setFieldError } from '../ui.js';
import { APP_VERSION } from '../../shared/version.js';
import { timeField } from '../pickers.js';
import { checkCalendarUrl } from '../../shared/calendar.js';

export function renderSettings(ctx) {
  const { store } = ctx;
  const d = store.data;
  const admin = d.me.role === 'admin';

  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', { text: 'Impostazioni' }), ctx.syncChip()),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card card-pad stack' },
        h('h2', { text: 'Il tuo account' }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Nome' }), h('dd', { text: d.me.name }),
          h('dt', { text: 'Email' }), h('dd', { text: d.me.email }),
          h('dt', { text: 'Ruolo' }), h('dd', { text: admin ? 'Amministratore' : 'Collaboratore' })),
        h('div', null, h('a', { class: 'btn small', href: '/cdn-cgi/access/logout', text: 'Esci' }))),
      h('section', { class: 'card card-pad stack' },
        h('h2', { text: 'Gestionale' }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Versione' }), h('dd', { text: APP_VERSION }),
          h('dt', { text: 'Ambiente' }), h('dd', { text: store.info.demo ? 'Prova, con dati inventati' : store.info.env === 'produzione' ? 'Definitiva (dati veri)' : store.info.env || '—' })),
        admin && store.info.demo ? demoBlock(ctx) : null,
        admin ? exportBlock(ctx) : null)),
    admin ? usersSection(ctx) : h('p', { class: 'section muted', text: 'Utenti, case e regole si cambiano solo dall’amministratore.' }),
    admin ? calendarsSection(ctx) : null,
    admin ? housesSection(ctx) : null);
}

/* ------------------------- Calendari Airbnb e Booking ------------------------- */

const PLATFORM = { airbnb: 'Airbnb', booking: 'Booking.com' };
const WHERE = {
  airbnb: 'Su Airbnb, dal computer: Annunci → scegli la casa → Disponibilità → Sincronizza calendari (o "Collega a un altro sito") → Esporta calendario → copia il link.',
  booking: 'Sull’extranet di Booking.com: Tariffe e disponibilità → Sincronizza calendari → Esporta calendario → copia il link.',
};

function when(iso) {
  try {
    return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch { return ''; }
}

function calendarStatus(c) {
  if (!c.connected) return { text: 'Non collegato', tone: '' };
  if (c.last_error) return { text: c.last_error, tone: 'warn' };
  if (c.last_ok_at) return { text: `Aggiornato ${when(c.last_ok_at)} · ${c.last_count ?? 0} ${c.last_count === 1 ? 'prenotazione futura' : 'prenotazioni future'}`, tone: 'ok' };
  return { text: 'Collegato: in attesa del primo aggiornamento', tone: '' };
}

function calendarsSection(ctx) {
  const d = ctx.store.data;
  const cals = d.calendars || [];
  const houses = Object.fromEntries(d.houses.map((x) => [x.id, x]));
  const rows = d.houses.flatMap((house) => ['airbnb', 'booking'].map((ch) => cals.find((c) => c.house_id === house.id && c.channel === ch)).filter(Boolean))
    .map((c) => {
      const st = calendarStatus(c);
      return h('div', { class: 'row' },
        h('span', { class: 'house-dot', vars: houseVars(houses[c.house_id]) }),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title', text: `${houses[c.house_id].name} · ${PLATFORM[c.channel]}` }),
          h('span', { class: 'row-sub' }, st.tone ? h('span', { class: ['tag', st.tone], text: st.tone === 'ok' ? 'Collegato' : 'Da controllare' }) : null,
            h('span', { text: st.text }))),
        h('span', { class: 'row-end btn-row' },
          h('button', { class: 'btn small', type: 'button', text: c.connected ? 'Cambia' : 'Collega', attrs: { 'aria-label': `${c.connected ? 'Cambia' : 'Collega'} il calendario ${PLATFORM[c.channel]} di ${houses[c.house_id].name}` }, onClick: () => calendarDialog(ctx, c) }),
          h('button', { class: 'btn small', type: 'button', text: `Link per ${c.channel === 'airbnb' ? 'Airbnb' : 'Booking'}`, onClick: () => exportDialog(ctx, c) })));
    });
  const anyConnected = cals.some((c) => c.connected);
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', { text: 'Calendari di Airbnb e Booking' }),
      anyConnected ? h('button', { class: 'btn small', type: 'button', onClick: (e) => syncNow(ctx, e.currentTarget) }, icon('refresh', { size: 16 }), 'Aggiorna ora') : null),
    h('div', { class: 'card' }, h('div', { class: 'rows' }, rows)),
    h('p', { class: 'hint', text: 'Le prenotazioni di Airbnb e Booking entrano da sole nel gestionale, con le date sempre aggiornate (controllo ogni 30 minuti). Nome, persone e telefono non arrivano dalle piattaforme: li completi tu nella prenotazione. Il link del calendario è riservato: lo vede solo il server, qui compare solo il sito.' }));
}

export async function syncNow(ctx, btn) {
  if (btn) { btn.disabled = true; btn.lastChild.textContent = 'Aggiornamento…'; }
  try {
    const r = await ctx.store.request('/api/calendars/sync', { method: 'POST', body: {} });
    await ctx.store.load({ force: true });
    const res = r.results || [];
    const sum = (k) => res.reduce((n, x) => n + (x[k] || 0), 0);
    const parts = [];
    if (sum('created')) parts.push(`${sum('created')} ${sum('created') === 1 ? 'nuova' : 'nuove'}`);
    if (sum('updated')) parts.push(`${sum('updated')} ${sum('updated') === 1 ? 'aggiornata' : 'aggiornate'}`);
    if (sum('cancelled')) parts.push(`${sum('cancelled')} ${sum('cancelled') === 1 ? 'cancellata' : 'cancellate'}`);
    const bad = res.filter((x) => !x.ok);
    if (bad.length) ctx.toast(`${bad.length === 1 ? 'Un calendario non si è aggiornato' : `${bad.length} calendari non si sono aggiornati`}: ${bad[0].error}`, { bad: true });
    else ctx.toast(parts.length ? `Calendari aggiornati: ${parts.join(', ')}` : 'Calendari aggiornati: nessuna novità');
  } catch (e) {
    ctx.toast(e.message, { bad: true });
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.lastChild.textContent = 'Aggiorna ora'; }
  }
}

const IMPORT_WHERE = {
  airbnb: 'Su Airbnb, dal computer: Annunci → scegli la casa → Disponibilità → Sincronizza calendari → Importa calendario → incolla il link e chiamalo "DigiHome".',
  booking: 'Sull’extranet di Booking.com: Tariffe e disponibilità → Sincronizza calendari → Aggiungi connessione calendario (Importa) → incolla il link e chiamalo "DigiHome".',
};

/** Il link che DigiHome dà alla piattaforma: date occupate dalle prenotazioni dirette e dall'altra piattaforma. */
function exportDialog(ctx, cal) {
  const d = ctx.store.data;
  const house = d.houses.find((x) => x.id === cal.house_id);
  const name = PLATFORM[cal.channel];
  const other = cal.channel === 'airbnb' ? 'Booking' : 'Airbnb';
  const base = ctx.store.info.calendarBase;
  const current = () => (ctx.store.data.calendars || []).find((c) => c.id === cal.id) || cal;
  const link = () => `${base}/cal/${current().export_token}.ics`;
  const box = h('div', { class: 'stack' });
  const draw = () => {
    if (!base || !current().export_token) {
      box.replaceChildren(h('p', { class: 'small', text: 'Questo link è disponibile solo nella versione definitiva del gestionale.' }));
      return;
    }
    const out = h('input', { class: 'input', type: 'text', readonly: true, value: link(), spellcheck: 'false', attrs: { 'aria-label': `Link per ${name}` } });
    out.addEventListener('focus', () => out.select());
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(link());
        ctx.toast('Link copiato');
      } catch {
        out.focus();
        out.select();
        ctx.toast('Tieni premuto sul link e scegli Copia', { bad: true });
      }
    };
    box.replaceChildren(
      h('p', { class: 'small', text: `Incollalo su ${name}: così le prenotazioni dirette e quelle di ${other} bloccano da sole le date su ${name}.` }),
      h('p', { class: 'small', text: IMPORT_WHERE[cal.channel] }),
      field(`Link da incollare su ${name}`, out),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small primary', type: 'button', onClick: copy }, icon('check', { size: 16 }), 'Copia il link')),
      h('p', { class: 'hint', text: `Contiene solo le date occupate, senza nomi né altri dati. ${name} lo rilegge da solo ogni poche ore.` }),
      h('div', null, h('button', { class: 'btn small danger', type: 'button', text: 'Crea un link nuovo', onClick: regenerate })),
      h('p', { class: 'hint', text: `Se il link è finito nelle mani sbagliate: quello vecchio smette di funzionare e va incollato quello nuovo su ${name}.` }));
  };
  async function regenerate() {
    const ok = await confirmDialog({ title: 'Creare un link nuovo?', text: `Il link attuale smetterà subito di funzionare: dovrai incollare quello nuovo su ${name}, altrimenti ${name} non vedrà più le date occupate.`, okLabel: 'Crea link nuovo', danger: true });
    if (!ok) return;
    try {
      await ctx.act('calendar.regenerate', { id: cal.id, version: current().version }, { message: 'Link nuovo creato' });
      draw();
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
  draw();
  const dlg = openDialog({
    title: `${house.name} · link per ${name}`,
    content: box,
    actions: [h('button', { class: 'btn', type: 'button', text: 'Chiudi', onClick: () => dlg.close() })],
  });
}

function calendarDialog(ctx, cal) {
  const d = ctx.store.data;
  const house = d.houses.find((x) => x.id === cal.house_id);
  const name = PLATFORM[cal.channel];
  let value = '';
  const input = h('input', { class: 'input', type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false',
    placeholder: cal.connected ? `Incolla il nuovo link (ora: ${cal.url_hint})` : 'https://…', maxlength: '1000',
    attrs: { 'aria-label': `Link del calendario ${name}` },
    onInput: (e) => { value = e.target.value; setFieldError(input, ''); } });
  const dlg = openDialog({
    title: `${house.name} · ${name}`,
    canClose: () => !value.trim() || confirmDialog({ title: 'Uscire senza collegare?', text: 'Il link che hai incollato non verrà salvato.', okLabel: 'Esci senza salvare' }),
    content: h('div', { class: 'stack' },
      h('p', { class: 'small', text: WHERE[cal.channel] }),
      h('p', { class: 'small muted', text: 'I nomi dei menu possono cambiare un po’. Il link giusto finisce di solito con .ics oppure contiene "ical".' }),
      field(`Link "Esporta calendario" di ${name}`, input),
      cal.connected ? h('div', { class: 'stack' },
        h('div', null, h('button', { class: 'btn small danger', type: 'button', text: 'Scollega questo calendario', onClick: disconnect })),
        h('p', { class: 'hint', text: 'Scollegando, le prenotazioni già arrivate restano nel gestionale; semplicemente non si aggiornano più.' })) : null),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Collega e aggiorna', onClick: save }),
    ],
  });
  setTimeout(() => input.focus(), 50);

  async function send(url, message) {
    const cur = (ctx.store.data.calendars || []).find((c) => c.id === cal.id) || cal;
    await ctx.act('calendar.update', { id: cal.id, version: cur.version, import_url: url }, { message });
  }
  async function save() {
    const checked = checkCalendarUrl(cal.channel, value);
    if (!checked.ok || !checked.url) {
      setFieldError(input, checked.ok ? 'Incolla il link del calendario.' : checked.error);
      input.focus();
      return;
    }
    try {
      await send(checked.url, 'Calendario collegato');
      value = '';
      dlg.close();
      await syncNow(ctx, null);
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
  async function disconnect() {
    const ok = await confirmDialog({ title: `Scollegare il calendario ${name}?`, text: `Le prenotazioni di ${name} di ${house.name} non si aggiorneranno più da sole.`, okLabel: 'Scollega', danger: true });
    if (!ok) return;
    try {
      await send(null, 'Calendario scollegato');
      value = '';
      dlg.close();
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
}

/** Copia di sicurezza scaricabile: tutti i dati in un file, da conservare sul computer. */
function exportBlock(ctx) {
  const run = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const data = await ctx.store.request('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, attrs: { download: `digihome-${data.env}-${data.exported_at.slice(0, 10)}.json` } });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      ctx.toast('Copia dei dati scaricata');
    } catch (err) {
      ctx.toast(err.message, { bad: true });
    } finally {
      btn.disabled = false;
    }
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted', text: 'Copia di sicurezza: scarica tutti i dati in un file (prenotazioni, note, cose da fare, storico). Contiene dati degli ospiti: tienilo in un posto sicuro.' }),
    h('div', null, h('button', { class: 'btn small', type: 'button', onClick: run }, icon('download', { size: 16 }), 'Scarica una copia dei dati')));
}

function demoBlock(ctx) {
  const run = async () => {
    const ok = await confirmDialog({
      title: 'Caricare i dati di prova?',
      text: 'Tutte le prenotazioni, le note e le cose da fare attuali verranno cancellate e sostituite con dati inventati. Utenti e case restano come sono.',
      okLabel: 'Carica dati di prova', danger: true,
    });
    if (!ok) return;
    try {
      await ctx.store.request('/api/demo', { method: 'POST', body: {} });
      await ctx.store.load({ force: true });
      ctx.toast('Dati di prova caricati');
      ctx.go('oggi');
    } catch (e) {
      ctx.toast(e.message, { bad: true });
    }
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted', text: 'Per provare il gestionale puoi ripartire da un insieme di prenotazioni inventate, con le date calcolate da oggi.' }),
    h('div', null, h('button', { class: 'btn small', type: 'button', onClick: run }, icon('refresh', { size: 16 }), 'Carica dati di prova')));
}

function usersSection(ctx) {
  const { store } = ctx;
  const d = store.data;
  const rows = d.users.map((u) => h('div', { class: 'row' },
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title', text: `${u.name}${u.id === d.me.id ? ' (tu)' : ''}` }),
      h('span', { class: 'row-sub' }, u.email, h('span', { class: ['tag', u.role === 'admin' ? 'ok' : ''], text: u.role === 'admin' ? 'Amministratore' : 'Collaboratore' }),
        u.active ? null : h('span', { class: 'tag warn', text: 'Disattivato' }))),
    h('span', { class: 'row-end' }, h('button', { class: 'btn small', type: 'button', text: 'Modifica', onClick: () => userDialog(ctx, u) }))));
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', { text: 'Chi può entrare' }),
      h('button', { class: 'btn small', type: 'button', onClick: () => userDialog(ctx, null) }, icon('plus', { size: 16 }), 'Aggiungi persona')),
    h('div', { class: 'card' }, h('div', { class: 'rows' }, rows)),
    h('p', { class: 'hint', text: 'Oltre a essere qui, l’email va aggiunta anche nella regola di accesso di Cloudflare: solo chi è in entrambi gli elenchi entra.' }));
}

function userDialog(ctx, user) {
  const isNew = !user;
  const v = user ? { name: user.name, role: user.role, active: Boolean(user.active) } : { name: '', email: '', role: 'collaboratore', active: true };
  const name = h('input', { class: 'input', type: 'text', maxlength: '80', value: v.name, onInput: (e) => { v.name = e.target.value; } });
  const email = isNew ? h('input', { class: 'input', type: 'email', maxlength: '160', autocomplete: 'off', onInput: (e) => { v.email = e.target.value; } }) : null;
  const role = h('select', { class: 'input', onChange: (e) => { v.role = e.target.value; } },
    h('option', { value: 'collaboratore', text: 'Collaboratore: usa tutto tranne le impostazioni', selected: v.role === 'collaboratore' }),
    h('option', { value: 'admin', text: 'Amministratore: può cambiare anche impostazioni e utenti', selected: v.role === 'admin' }));
  const dlg = openDialog({
    title: isNew ? 'Aggiungi persona' : `Modifica ${user.name}`,
    content: h('div', { class: 'stack' },
      field('Nome', name),
      email ? field('Email', email, { hint: 'La stessa con cui accederà.' }) : null,
      field('Ruolo', role),
      isNew ? null : switchRow('Può entrare nel gestionale', { checked: v.active, onChange: (c) => { v.active = c; } })),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
    ],
  });
  async function save() {
    try {
      if (isNew) await ctx.act('user.add', { email: v.email, name: v.name, role: v.role }, { message: 'Persona aggiunta' });
      else await ctx.act('user.update', { id: user.id, version: user.version, changes: { name: v.name, role: v.role, active: v.active } }, { message: 'Salvato' });
      dlg.close();
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
}

function housesSection(ctx) {
  const d = ctx.store.data;
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { text: 'Case' })),
    h('div', { class: 'grid-2' }, d.houses.map((x) => h('div', { class: 'card house-card', vars: houseVars(x) },
      h('div', { class: 'house-top' }, h('span', { class: 'name', text: x.name })),
      h('div', { class: 'house-body' },
        h('dl', { class: 'kv' },
          h('dt', { text: 'Ospiti massimi' }), h('dd', { text: String(x.max_guests) }),
          h('dt', { text: 'Check-in' }), h('dd', { text: `dalle ${x.checkin_time}` }),
          h('dt', { text: 'Check-out' }), h('dd', { text: `entro le ${x.checkout_time}` })),
        h('div', null, h('button', { class: 'btn small', type: 'button', text: 'Modifica', onClick: () => houseDialog(ctx, x) })))))));
}

function houseDialog(ctx, house) {
  const v = { max_guests: house.max_guests, checkin_time: house.checkin_time, checkout_time: house.checkout_time };
  const max = h('input', { class: 'input', type: 'number', min: '1', max: '50', inputmode: 'numeric', value: String(v.max_guests), onInput: (e) => { v.max_guests = Number(e.target.value); } });
  const cin = timeField({ value: v.checkin_time, label: 'Check-in dalle', quick: ['13:00', '14:00', '15:00', '16:00'], onChange: (t) => { v.checkin_time = t; } });
  const cout = timeField({ value: v.checkout_time, label: 'Check-out entro le', quick: ['09:00', '10:00', '11:00', '12:00'], onChange: (t) => { v.checkout_time = t; } });
  const dlg = openDialog({
    title: house.name,
    content: h('div', { class: 'form-grid' },
      field('Ospiti massimi', max, { full: true }),
      h('div', { class: 'field' }, h('div', { class: 'label', text: 'Check-in dalle' }), cin.el),
      h('div', { class: 'field' }, h('div', { class: 'label', text: 'Check-out entro le' }), cout.el)),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Annulla', onClick: () => dlg.close() }),
      h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: save }),
    ],
  });
  async function save() {
    if (!v.checkin_time || !v.checkout_time) { dlg.setBanner('Scrivi gli orari di check-in e check-out (es. 14:00).'); return; }
    try {
      await ctx.act('house.update', { id: house.id, version: house.version, changes: v }, { message: 'Salvato' });
      dlg.close();
    } catch (e) {
      dlg.setBanner(e.message);
    }
  }
}
