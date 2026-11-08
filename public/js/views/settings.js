// Impostazioni: account, utenti e case (solo amministratore), dati di prova.

import { h, icon } from '../dom.js';
import { houseVars, field, openDialog, confirmDialog, switchRow } from '../ui.js';
import { APP_VERSION } from '../../shared/version.js';
import { timeField } from '../pickers.js';

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
          h('dt', { text: 'Ambiente' }), h('dd', { text: store.info.demo ? 'Prova, con dati inventati' : store.info.env || '—' })),
        admin && store.info.demo ? demoBlock(ctx) : null)),
    admin ? usersSection(ctx) : h('p', { class: 'section muted', text: 'Utenti, case e regole si cambiano solo dall’amministratore.' }),
    admin ? housesSection(ctx) : null);
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
