// Modulo online per gli ospiti (italiano / inglese). Nessuna libreria, nessun dato salvato sul telefono.
// L'ospite compila i dati di tutti: arrivano direttamente nella scheda della prenotazione.
'use strict';

(() => {
  const token = (/^\/([1-9A-HJ-NP-Za-km-z]{12})$/.exec(location.pathname) || [])[1];
  const app = document.getElementById('app');

  /* ------------------------------ Testi ------------------------------ */

  const T = {
    it: {
      title: 'Registrazione degli ospiti',
      stay: (from, to) => `Dal ${from} al ${to}`,
      guestsN: (n) => `${n} ${n === 1 ? 'ospite' : 'ospiti'}`,
      intro: 'La legge italiana ci chiede di comunicare alla Polizia di Stato i dati di tutti gli ospiti entro 24 ore dall’arrivo. Compilando qui prima di arrivare, al check-in ci basterà vedere i documenti: più veloce per tutti.',
      already: 'Abbiamo già ricevuto i vostri dati. Se serve correggere qualcosa, compila di nuovo il modulo: sostituirà quello precedente.',
      guest: (i) => (i === 0 ? 'Chi ha prenotato' : `Ospite ${i + 1}`),
      leaderTag: 'con documento',
      last: 'Cognome', first: 'Nome', sex: 'Sesso', male: 'Maschio', female: 'Femmina',
      birth: 'Data di nascita', birthHint: 'gg/mm/aaaa',
      birthPlace: 'Luogo di nascita', citizenship: 'Cittadinanza', residence: 'Residenza',
      inItaly: 'In Italia', abroad: 'All’estero',
      comune: 'Scrivi il comune…', country: 'Scrivi lo stato…',
      docTitle: 'Documento', docType: 'Tipo di documento', docNumber: 'Numero del documento', docPlace: 'Rilasciato in', choose: 'Scegli…',
      docNote: 'Serve solo per chi ha prenotato. All’arrivo ti chiederemo di vederlo.',
      sameAs: 'Cittadinanza e residenza come chi ha prenotato',
      add: 'Aggiungi un ospite', remove: 'Togli',
      group: 'Viaggiate come', family: 'Famiglia', friends: 'Gruppo di amici',
      privacyTitle: 'Privacy',
      privacy: (who) => `Titolare del trattamento: ${who}. I dati servono solo per la comunicazione obbligatoria alla Questura (Alloggiati Web, art. 109 TULPS) e, senza nomi, per le statistiche turistiche della Regione Puglia. Non li usiamo per altro e non li diamo ad altri. I dati del documento si cancellano appena la Questura conferma la ricezione; gli altri dopo un anno dalla partenza.`,
      agree: 'Ho letto e confermo che i dati sono corretti',
      send: 'Invia i dati', sending: 'Invio in corso…',
      doneTitle: 'Grazie, dati ricevuti!',
      doneText: 'All’arrivo ti chiederemo solo di mostrare i documenti. A presto!',
      again: 'Correggi i dati',
      closed: {
        done: 'I dati di questo soggiorno sono già stati registrati. Per qualsiasi cosa scrivici.',
        expired: 'Questo link è scaduto. Per qualsiasi cosa scrivici.',
        cancelled: 'Questo soggiorno è stato cancellato.',
        too_many: 'Il modulo è stato inviato troppe volte. Per correggere i dati scrivici.',
        not_found: 'Link non valido. Controlla di averlo copiato per intero.',
      },
      required: 'Campo obbligatorio', badDate: 'Data non valida (gg/mm/aaaa)', pickList: 'Scrivi e sceglilo dall’elenco che compare', pickWhere: 'Scegli se in Italia o all’estero',
      noPlace: 'Nessun risultato', fixErrors: 'Controlla i campi segnati in rosso.', agreeFirst: 'Conferma di aver letto l’informativa.',
      network: 'Connessione assente: riprova tra poco.', latin: 'Scrivi in lettere latine, come sul passaporto',
      docChars: 'Solo lettere e numeri',
    },
    en: {
      title: 'Guest registration',
      stay: (from, to) => `From ${from} to ${to}`,
      guestsN: (n) => `${n} ${n === 1 ? 'guest' : 'guests'}`,
      intro: 'Italian law requires us to send the details of every guest to the State Police within 24 hours of arrival. If you fill in this form before you arrive, at check-in we only need to see your IDs: quicker for everyone.',
      already: 'We have already received your details. If something needs correcting, just fill in the form again: it will replace the previous one.',
      guest: (i) => (i === 0 ? 'Lead guest (who booked)' : `Guest ${i + 1}`),
      leaderTag: 'with ID',
      last: 'Surname', first: 'First name', sex: 'Sex', male: 'Male', female: 'Female',
      birth: 'Date of birth', birthHint: 'dd/mm/yyyy',
      birthPlace: 'Place of birth', citizenship: 'Citizenship', residence: 'Country / town of residence',
      inItaly: 'In Italy', abroad: 'Abroad',
      comune: 'Type the Italian town…', country: 'Type the country (English or Italian)…',
      docTitle: 'ID document', docType: 'Type of document', docNumber: 'Document number', docPlace: 'Issued in', choose: 'Choose…',
      docNote: 'Only for the lead guest. We will ask to see it on arrival.',
      sameAs: 'Same citizenship and residence as the lead guest',
      add: 'Add a guest', remove: 'Remove',
      group: 'You are travelling as', family: 'Family', friends: 'Group of friends',
      privacyTitle: 'Privacy',
      privacy: (who) => `Data controller: ${who}. Your details are used only for the mandatory report to the Police (Alloggiati Web, art. 109 TULPS) and, without names, for the tourism statistics of the Puglia Region. We do not use them for anything else or share them with anyone else. ID details are deleted as soon as the Police confirm receipt; the rest one year after departure.`,
      agree: 'I have read this and confirm the details are correct',
      send: 'Send details', sending: 'Sending…',
      doneTitle: 'Thank you, details received!',
      doneText: 'On arrival we will only ask to see your IDs. See you soon!',
      again: 'Correct the details',
      closed: {
        done: 'The details for this stay have already been registered. Please contact us for anything else.',
        expired: 'This link has expired. Please contact us for anything else.',
        cancelled: 'This stay has been cancelled.',
        too_many: 'This form has been sent too many times. Please contact us to correct the details.',
        not_found: 'Invalid link. Please check that you copied all of it.',
      },
      required: 'Required', badDate: 'Invalid date (dd/mm/yyyy)', pickList: 'Type and pick it from the list that appears', pickWhere: 'Choose Italy or abroad',
      noPlace: 'No results', fixErrors: 'Please check the fields marked in red.', agreeFirst: 'Please confirm you have read the privacy notice.',
      network: 'No connection: please try again shortly.', latin: 'Please use Latin letters, as in your passport',
      docChars: 'Letters and numbers only',
    },
  };
  // Traduzione inglese dei tipi di documento più comuni (le tabelle ufficiali sono in italiano).
  const DOC_EN = { IDENT: 'Identity card', IDELE: 'Electronic identity card', PASOR: 'Passport', PATEN: 'Driving licence', PASDI: 'Diplomatic passport', PASSE: 'Service passport' };
  const COMMON_DOCS = ['IDELE', 'IDENT', 'PASOR', 'PATEN'];

  let lang = (navigator.language || 'it').toLowerCase().startsWith('it') ? 'it' : 'en';
  const t = () => T[lang];

  /* ------------------------------ DOM ------------------------------ */

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }
  let uid = 0;
  const nextId = () => `f${++uid}`;
  const itDate = (iso) => iso.split('-').reverse().join('/');

  async function api(path, opts = {}) {
    const res = await fetch(`/api/form/${token}${path}`, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || data.ok === false) {
      const e = new Error((data && data.message) || `HTTP ${res.status}`);
      e.code = data && data.code;
      e.extra = data || {};
      throw e;
    }
    return data;
  }

  /* ------------------------------ Stato ------------------------------ */

  let info = null;
  let guests = [];
  let group = 'famiglia';
  let agreed = false;
  const blankGuest = () => ({ last_name: '', first_name: '', sex: null, birth_date: '', birth_text: '',
    birth_place: null, birth_name: '', birth_it: null, citizenship: null, citizenship_name: '',
    residence: null, residence_name: '', res_it: null, doc_type: '', doc_number: '', doc_place: null, doc_place_name: '', doc_it: null });

  /* ------------------------------ Campi ------------------------------ */

  function field(label, control, { hint, error } = {}) {
    const id = control.id || (control.id = nextId());
    const lab = h('label', { class: 'label', for: id, text: label });
    return h('div', { class: 'field' }, lab, control, hint ? h('span', { class: 'hint', text: hint }) : null, error ? h('span', { class: 'err', text: error }) : null);
  }
  function seg(options, value, onChange, label) {
    return h('div', { class: 'seg', role: 'group', 'aria-label': label },
      options.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(value === v), text: l, onClick: () => onChange(v) })));
  }

  /** Ricerca di un comune (kind C) o di uno stato (kind S). */
  function placeInput(kind, current, name, onPick) {
    const wrap = h('div', { class: 'place' });
    const listId = nextId();
    const input = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', value: name || '', placeholder: kind === 'C' ? t().comune : t().country,
      role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', 'aria-controls': listId });
    const list = h('ul', { class: 'place-list', id: listId, role: 'listbox' });
    list.hidden = true;
    let items = []; let active = -1; let timer = null; let seq = 0; let chosen = Boolean(current);
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    const pick = (p) => { chosen = true; input.value = p.kind === 'C' && p.province ? `${p.name} (${p.province})` : p.name; clearError(input); close(); onPick(p); };
    const paint = (msg) => {
      list.replaceChildren(...(msg ? [h('li', { class: 'empty', text: msg })] : items.map((p, i) => h('li', {
        class: i === active ? 'active' : '', role: 'option', 'aria-selected': String(i === active),
        text: p.kind === 'C' && p.province ? `${p.name} (${p.province})` : p.name,
        onPointerdown: (e) => { e.preventDefault(); pick(p); },
      }))));
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    input.addEventListener('input', () => {
      if (chosen) { chosen = false; onPick(null); }
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const r = await api(`/places?q=${encodeURIComponent(q)}&kind=${kind}`);
          if (my !== seq) return;
          items = r.places || [];
          active = items.length ? 0 : -1;
          paint(items.length ? null : t().noPlace);
        } catch { if (my === seq) paint(t().network); }
      }, 200);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) pick(items[active]); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    wrap.append(input, list);
    return wrap;
  }

  /** Luogo con scelta Italia / estero (nascita, residenza, rilascio del documento). */
  function placeWithCountry(g, codeKey, nameKey, itKey, label, error) {
    const box = h('div', { class: 'field' });
    const draw = () => {
      const it = g[itKey];
      const choose = seg([[true, t().inItaly], [false, t().abroad]], it, (v) => { if (v !== g[itKey]) { g[itKey] = v; g[codeKey] = null; g[nameKey] = ''; } draw(); }, label);
      const input = it === null ? null : placeInput(it ? 'C' : 'S', g[codeKey], g[nameKey], (p) => { g[codeKey] = p ? p.code : null; g[nameKey] = p ? (p.kind === 'C' && p.province ? `${p.name} (${p.province})` : p.name) : ''; });
      if (input && error) input.querySelector('input').setAttribute('aria-invalid', 'true');
      box.replaceChildren(...[h('span', { class: 'label', text: label }), choose, input, error ? h('span', { class: 'err', text: error }) : null].filter(Boolean));
    };
    draw();
    return box;
  }

  /* ------------------------------ Controlli ------------------------------ */

  function parseDate(s) {
    const m = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{4})$/.exec(String(s || '').trim());
    if (!m) return null;
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const today = new Date().toISOString().slice(0, 10);
    if (iso > today || y < 1900) return null;
    return iso;
  }
  // Lettere latine (anche accentate), spazi, apostrofi e trattini.
  function latinOk(s) {
    for (const ch of String(s).normalize('NFD')) {
      const c = ch.codePointAt(0);
      if ((c >= 0x300 && c <= 0x36f) || /[A-Za-z\s'’`-]/.test(ch)) continue;
      if ('ßØøÆæŒœŁłĐđÞþı'.includes(ch)) continue;
      return false;
    }
    return true;
  }

  function validate() {
    const errs = guests.map(() => ({}));
    guests.forEach((g, i) => {
      const e = errs[i];
      if (!g.last_name.trim()) e.last_name = t().required; else if (!latinOk(g.last_name)) e.last_name = t().latin;
      if (!g.first_name.trim()) e.first_name = t().required; else if (!latinOk(g.first_name)) e.first_name = t().latin;
      if (!g.sex) e.sex = t().required;
      g.birth_date = parseDate(g.birth_text) || '';
      if (!g.birth_date) e.birth_date = g.birth_text ? t().badDate : t().required;
      if (!g.birth_place) e.birth_place = g.birth_it === null ? t().pickWhere : t().pickList;
      if (!g.citizenship) e.citizenship = t().pickList;
      if (!g.residence) e.residence = g.res_it === null ? t().pickWhere : t().pickList;
      if (i === 0) {
        if (!g.doc_type) e.doc_type = t().required;
        if (!g.doc_number.trim()) e.doc_number = t().required;
        else if (!/^[A-Za-z0-9\s-]+$/.test(g.doc_number)) e.doc_number = t().docChars;
        if (!g.doc_place) e.doc_place = g.doc_it === null ? t().pickWhere : t().pickList;
      }
    });
    return errs;
  }

  /* ------------------------------ Pagina ------------------------------ */

  function header() {
    return [
      h('div', { class: 'top' },
        h('div', null, h('h1', { text: t().title }), h('p', { class: 'hint', text: info ? info.house : '' })),
        h('div', { class: 'lang', role: 'group', 'aria-label': 'Lingua / Language' },
          [['it', 'IT'], ['en', 'EN']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(lang === v), text: l,
            onClick: () => { lang = v; document.documentElement.lang = v; render(); } })))),
    ];
  }

  let errors = [];
  let banner = null;
  let tried = false; // dopo il primo tentativo di invio gli errori si aggiornano a ogni modifica

  /** Toglie l'errore mostrato sotto un campo appena l'ospite lo corregge. */
  function clearError(input) {
    input.removeAttribute('aria-invalid');
    const err = input.closest('.field') && input.closest('.field').querySelector('.err');
    if (err) err.remove();
  }

  function guestCard(g, i) {
    const e = errors[i] || {};
    const has = Object.keys(e).length > 0;
    const text = (key, label, extra = {}) => {
      const input = h('input', { class: 'input', value: g[key], maxlength: key === 'first_name' ? '30' : key === 'doc_number' ? '20' : '50', ...extra,
        'aria-invalid': e[key] ? 'true' : null, onInput: (ev) => { g[key] = ev.target.value; clearError(ev.target); } });
      return field(label, input, { error: e[key] });
    };
    const birth = h('input', { class: 'input', value: g.birth_text, inputmode: 'numeric', placeholder: t().birthHint, maxlength: '10', autocomplete: i === 0 ? 'bday' : 'off',
      'aria-invalid': e.birth_date ? 'true' : null,
      onInput: (ev) => {
        // Aggiunge da solo le barre: 12031985 → 12/03/1985
        let v = ev.target.value.replace(/[^\d/]/g, '');
        if (/^\d{3,}$/.test(v)) v = v.length <= 4 ? `${v.slice(0, 2)}/${v.slice(2)}` : `${v.slice(0, 2)}/${v.slice(2, 4)}/${v.slice(4, 8)}`;
        ev.target.value = v;
        g.birth_text = v;
        clearError(ev.target);
      } });
    const citizenship = h('div', { class: 'field' }, h('span', { class: 'label', text: t().citizenship }),
      placeInput('S', g.citizenship, g.citizenship_name, (p) => { g.citizenship = p ? p.code : null; g.citizenship_name = p ? p.name : ''; }),
      e.citizenship ? h('span', { class: 'err', text: e.citizenship }) : null);
    const lead = guests[0];
    const copy = i > 0 && lead.citizenship && lead.residence ? h('button', { class: 'btn', type: 'button', text: t().sameAs, onClick: () => {
      Object.assign(g, { citizenship: lead.citizenship, citizenship_name: lead.citizenship_name, residence: lead.residence, residence_name: lead.residence_name, res_it: lead.res_it });
      render();
    } }) : null;
    const doc = i === 0 ? [
      h('h3', { text: t().docTitle }),
      h('p', { class: 'hint', text: t().docNote }),
      h('div', { class: 'grid' },
        field(t().docType, h('select', { class: 'input', 'aria-invalid': e.doc_type ? 'true' : null, onChange: (ev) => { g.doc_type = ev.target.value; } },
          h('option', { value: '', text: t().choose }),
          ...docOptions(g.doc_type)), { error: e.doc_type }),
        text('doc_number', t().docNumber, { autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' })),
      placeWithCountry(g, 'doc_place', 'doc_place_name', 'doc_it', t().docPlace, e.doc_place),
    ] : [];
    return h('section', { class: ['card', has && 'error'], 'aria-label': t().guest(i) },
      h('div', { class: 'card-head' }, h('h2', { text: t().guest(i) }),
        i === 0 ? h('span', { class: 'tag', text: t().leaderTag })
          : h('button', { class: 'btn ghost', type: 'button', text: t().remove, onClick: () => { guests.splice(i, 1); errors.splice(i, 1); render(); } })),
      h('div', { class: 'grid' },
        text('last_name', t().last, { autocomplete: i === 0 ? 'family-name' : 'off', autocapitalize: 'words' }),
        text('first_name', t().first, { autocomplete: i === 0 ? 'given-name' : 'off', autocapitalize: 'words' })),
      h('div', { class: 'grid' },
        h('div', { class: 'field' }, h('span', { class: 'label', text: t().sex }),
          seg([['M', t().male], ['F', t().female]], g.sex, (v) => { g.sex = v; render(); }, t().sex),
          e.sex ? h('span', { class: 'err', text: e.sex }) : null),
        field(t().birth, birth, { error: e.birth_date })),
      placeWithCountry(g, 'birth_place', 'birth_name', 'birth_it', t().birthPlace, e.birth_place),
      copy,
      citizenship,
      placeWithCountry(g, 'residence', 'residence_name', 'res_it', t().residence, e.residence),
      ...doc);
  }

  function docOptions(selected) {
    const list = info.docTypes || [];
    const common = COMMON_DOCS.map((c) => list.find((d) => d.code === c)).filter(Boolean);
    const rest = list.filter((d) => !COMMON_DOCS.includes(d.code));
    const label = (d) => (lang === 'en' && DOC_EN[d.code] ? `${DOC_EN[d.code]} (${d.name.toLowerCase()})` : d.name.charAt(0) + d.name.slice(1).toLowerCase());
    const opt = (d) => h('option', { value: d.code, text: label(d), selected: d.code === selected ? 'selected' : null });
    return [...common.map(opt), common.length && rest.length ? h('option', { disabled: 'disabled', text: '──────────' }) : null, ...rest.map(opt)].filter(Boolean);
  }

  function render() {
    if (!info) return;
    document.title = `${t().title} · ${info.house}`;
    if (!info.open) {
      app.replaceChildren(...header(), h('div', { class: 'card' }, h('p', { text: t().closed[info.reason] || t().closed.not_found })));
      return;
    }
    if (tried) errors = validate();
    const scrollY = window.scrollY;
    const focusedId = document.activeElement && document.activeElement.id;
    const agree = h('input', { type: 'checkbox', checked: agreed ? 'checked' : null, onChange: (ev) => { agreed = ev.target.checked; } });
    const sendBtn = h('button', { class: 'btn primary', type: 'button', text: t().send, onClick: () => submit(sendBtn) });
    app.replaceChildren(...[
      ...header(),
      h('div', { class: 'stay' },
        h('span', null, h('strong', { text: t().stay(itDate(info.check_in), itDate(info.check_out)) })),
        h('span', { text: t().guestsN(info.guests) })),
      h('p', { class: 'intro', text: t().intro }),
      info.submitted ? h('div', { class: 'banner ok', text: t().already }) : null,
      ...guests.map(guestCard),
      h('div', { class: 'row', 'data-gap': '1' },
        guests.length < Math.min(30, info.guests + 4) ? h('button', { class: 'btn', type: 'button', text: `+ ${t().add}`, onClick: () => { guests.push(blankGuest()); render(); } }) : null),
      guests.length > 1 ? h('div', { class: 'card' }, h('span', { class: 'label', text: t().group }),
        seg([['famiglia', t().family], ['gruppo', t().friends]], group, (v) => { group = v; render(); }, t().group)) : null,
      h('div', { class: 'card' },
        h('div', { class: 'privacy' }, h('strong', { text: t().privacyTitle }), h('p', { text: t().privacy(info.controller || info.house) })),
        h('label', { class: 'check' }, agree, h('span', { text: t().agree })),
        banner ? h('div', { class: 'banner bad', role: 'alert', text: banner }) : null,
        sendBtn),
      h('p', { class: 'foot', text: info.house })].filter(Boolean));
    window.scrollTo(0, scrollY);
    if (focusedId && document.getElementById(focusedId)) document.getElementById(focusedId).focus();
  }

  async function submit(btn) {
    tried = true;
    errors = validate();
    banner = null;
    const firstBad = errors.findIndex((e) => Object.keys(e).length);
    if (firstBad >= 0) { banner = t().fixErrors; render(); scrollToCard(firstBad); return; }
    if (!agreed) { banner = t().agreeFirst; render(); return; }
    btn.disabled = true;
    btn.textContent = t().sending;
    try {
      await api('', { method: 'POST', body: { group, guests: guests.map((g, i) => ({
        last_name: g.last_name.trim(), first_name: g.first_name.trim(), sex: g.sex, birth_date: g.birth_date,
        birth_place: g.birth_place, citizenship: g.citizenship, residence: g.residence,
        doc_type: i === 0 ? g.doc_type : null, doc_number: i === 0 ? g.doc_number.trim() : null, doc_place: i === 0 ? g.doc_place : null,
      })) } });
      guests = []; // nessuna copia dei dati resta nella pagina
      app.replaceChildren(...header(), h('div', { class: 'card done' },
        h('div', { class: 'big', text: '✓' }), h('h2', { text: t().doneTitle }), h('p', { text: t().doneText })));
      window.scrollTo(0, 0);
    } catch (e) {
      banner = e.message === 'Failed to fetch' ? t().network : e.message;
      if (e.extra && Number.isInteger(e.extra.index)) errors[e.extra.index] = { ...(errors[e.extra.index] || {}), server: true };
      if (e.code && !['validation', 'server', 'forbidden'].includes(e.code)) info = { ...info, open: false, reason: T.it.closed[e.code] ? e.code : 'expired' };
      render();
      if (e.extra && Number.isInteger(e.extra.index)) scrollToCard(e.extra.index);
    }
  }

  function scrollToCard(i) {
    const cards = app.querySelectorAll('section.card');
    if (cards[i]) cards[i].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ------------------------------ Avvio ------------------------------ */

  async function start() {
    if (!token) {
      info = { open: false, reason: 'not_found', house: '' };
      render();
      return;
    }
    try {
      const r = await api('');
      info = r.form;
      // Il colore della casa (come sul sito): un tocco di riconoscibilità.
      if (info.color) document.documentElement.style.setProperty('--accent', info.color);
      guests = Array.from({ length: Math.max(1, info.guests || 1) }, blankGuest);
      document.documentElement.lang = lang;
      render();
    } catch (e) {
      info = { open: false, reason: e.code === 'not_found' ? 'not_found' : 'not_found', house: '' };
      if (e.message === 'Failed to fetch') { app.replaceChildren(h('p', { class: 'loading', text: t().network })); return; }
      render();
    }
  }
  start();
})();
