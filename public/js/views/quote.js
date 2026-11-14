// Preventivo: date, persone ed extra → prezzo consigliato dallo storico → messaggio WhatsApp.
// La casa è quella scelta in alto (resta la stessa passando da una sezione all'altra).
// Il preventivo NON si salva: i dati scritti restano solo finché l'app è aperta (niente bozze con nomi e telefoni).

import { h, icon } from '../dom.js';
import { houseVars, segmented, field, switchRow, setFieldError, chan } from '../ui.js';
import { addDays, daysBetween, isIsoDate, formatItDate } from '../../shared/dates.js';
import { fmtEuro, parseEuro, centsToInput } from '../../shared/money.js';
import { touristTax, taxSettings, explainTax } from '../../shared/tax.js';
import { parseContractInfo } from '../../shared/contract.js';
import { EXTRA_UNITS, depositFor, extraAmount, historyPrice, quoteChecks, quoteMessage, quoteSettings, suggestPrice } from '../../shared/quote.js';
import { waNumber } from './contact.js';

// Bozza del preventivo in memoria (si perde chiudendo l'app: è voluto).
let draft = null;
const fresh = () => ({
  checkIn: '', checkOut: '', guests: 2, name: '', phone: '', lang: 'it',
  linens: null, towels: null, extras: {}, security: null,
  price: '', priceTouched: false, deposit: '', depositTouched: false,
  message: '', messageTouched: false,
});

/** Regole della casa che servono al messaggio (luce compresa, acconto): per i collaboratori senza dati personali. */
function houseRules(house) {
  if (house.contract_info) return parseContractInfo(house);
  try { return JSON.parse(house.contract_public || '{}') || {}; } catch { return {}; }
}

export function renderQuote(ctx) {
  const { store, ui } = ctx;
  const d = store.data;
  const house = d.houses.find((x) => x.id === ui.houseId) || d.houses[0];
  if (!draft) draft = fresh();
  const q = draft;
  const settings = quoteSettings(house);
  const rules = houseRules(house);
  const taxSet = taxSettings(house);
  const pct = rules.advance_pct || 30;
  const linens = () => (q.linens === null ? Boolean(house.default_linens ?? 1) : q.linens);
  const towels = () => (q.towels === null ? Boolean(house.default_towels ?? 0) : q.towels);
  const security = () => (q.security === null ? settings.security_cents : q.security);

  /* ------------------------------ Campi ------------------------------ */
  const inputs = {};
  const onChange = () => refresh();
  const dateIn = h('input', { class: 'input', dataset: { key: 'q-in' }, type: 'date', value: q.checkIn, min: ui.today, onInput: (e) => {
    q.checkIn = e.target.value;
    // Partenza automatica una settimana dopo se manca o è prima dell'arrivo.
    if (isIsoDate(q.checkIn) && (!isIsoDate(q.checkOut) || q.checkOut <= q.checkIn)) { q.checkOut = addDays(q.checkIn, 7); dateOut.value = q.checkOut; }
    dateOut.min = isIsoDate(q.checkIn) ? addDays(q.checkIn, 1) : ui.today;
    setFieldError(dateIn, ''); onChange();
  } });
  const dateOut = h('input', { class: 'input', dataset: { key: 'q-out' }, type: 'date', value: q.checkOut, min: isIsoDate(q.checkIn) ? addDays(q.checkIn, 1) : ui.today,
    onInput: (e) => { q.checkOut = e.target.value; setFieldError(dateOut, ''); onChange(); } });
  const guestsIn = h('input', { class: 'input', dataset: { key: 'q-guests' }, type: 'number', inputmode: 'numeric', min: '1', max: String(house.max_guests), value: String(q.guests),
    onInput: (e) => { q.guests = Math.max(0, Math.floor(Number(e.target.value) || 0)); onChange(); } });
  const nameIn = h('input', { class: 'input', dataset: { key: 'q-name' }, autocomplete: 'off', value: q.name, placeholder: 'Facoltativo', onInput: (e) => { q.name = e.target.value; onChange(); } });
  const phoneIn = h('input', { class: 'input', dataset: { key: 'q-phone' }, type: 'tel', autocomplete: 'off', value: q.phone, placeholder: 'Facoltativo', onInput: (e) => { q.phone = e.target.value; setFieldError(phoneIn, ''); } });
  Object.assign(inputs, { dateIn, dateOut, guestsIn });

  const langSeg = h('div');
  const drawLang = () => langSeg.replaceChildren(segmented([{ value: 'it', label: 'Italiano' }, { value: 'en', label: 'English' }], q.lang,
    (v) => { q.lang = v; drawLang(); onChange(); }, 'Lingua del messaggio'));
  drawLang();

  const extrasBox = h('div', { class: 'stack' },
    switchRow('Lenzuola', { checked: linens(), onChange: (c) => { q.linens = c; onChange(); } }),
    switchRow('Asciugamani', { checked: towels(), onChange: (c) => { q.towels = c; onChange(); } }),
    settings.extras.map((x) => switchRow(`${x.label} · ${fmtEuro(x.price_cents)} ${EXTRA_UNITS[x.unit].short}`, {
      checked: Boolean(q.extras[x.id]), onChange: (c) => { q.extras[x.id] = c; onChange(); } })));

  const stayCard = h('section', { class: 'card card-pad stack' },
    h('h2', { text: 'Soggiorno' }),
    h('div', { class: 'form-grid' },
      field('Arrivo', dateIn),
      field('Partenza', dateOut),
      field('Persone', guestsIn, { hint: `Massimo ${house.max_guests}` }),
      field('Nome dell’ospite', nameIn),
      field('Telefono (per aprire la chat)', phoneIn, { full: true, hint: 'Facoltativo: senza numero scegli tu la chat in WhatsApp' })),
    h('div', { class: 'field' }, h('div', { class: 'label', text: 'Lingua del messaggio' }), langSeg),
    h('h3', { text: 'Compreso ed extra' }),
    extrasBox);

  /* ------------------------------ Risultati ------------------------------ */
  const checksBox = h('div', { class: 'stack' });
  const suggestBox = h('div', { class: 'stack' });
  const priceIn = h('input', { class: 'input', dataset: { key: 'q-price' }, inputmode: 'decimal', value: q.price, onInput: (e) => { q.price = e.target.value; q.priceTouched = true; setFieldError(priceIn, ''); onChange(); } });
  const depositIn = h('input', { class: 'input', dataset: { key: 'q-deposit' }, inputmode: 'decimal', value: q.deposit, onInput: (e) => { q.deposit = e.target.value; q.depositTouched = true; setFieldError(depositIn, ''); onChange(); } });
  const securityIn = h('input', { class: 'input', dataset: { key: 'q-security' }, inputmode: 'decimal', value: centsToInput(security()), onInput: (e) => {
    const c = parseEuro(e.target.value);
    q.security = c === null ? security() : c;
    setFieldError(securityIn, c === null ? 'Importo non valido' : '');
    onChange();
  } });
  const taxLine = h('p', { class: 'muted small' });
  const useSuggested = h('button', { class: 'btn ghost small', type: 'button', text: 'Usa il prezzo consigliato', hidden: true, onClick: () => { q.priceTouched = false; q.depositTouched = false; refresh(); } });

  const priceCard = h('section', { class: 'card card-pad stack' },
    h('h2', { text: 'Prezzo consigliato' }),
    suggestBox,
    h('div', { class: 'form-grid' },
      field('Prezzo del soggiorno (€)', priceIn),
      field(`Acconto (€) · circa ${pct}%`, depositIn, { hint: 'Arrotondato a 50 €; puoi cambiarlo' }),
      field('Cauzione (€)', securityIn)),
    useSuggested,
    taxLine);

  const msgArea = h('textarea', { class: 'input quote-msg', dataset: { key: 'q-msg' }, rows: '18', onInput: (e) => { q.message = e.target.value; q.messageTouched = true; regenBtn.hidden = false; } });
  const regenBtn = h('button', { class: 'btn ghost small', type: 'button', text: 'Rifai il messaggio dai dati', hidden: !q.messageTouched,
    onClick: () => { q.messageTouched = false; regenBtn.hidden = true; refresh(); } });
  const sendBtn = h('button', { class: 'btn house', type: 'button', onClick: send }, icon('chat', { size: 16 }), 'Invia su WhatsApp');
  const copyBtn = h('button', { class: 'btn', type: 'button', onClick: copy }, 'Copia il testo');
  const msgBanner = h('div', { class: 'banner warn', hidden: true });
  const msgCard = h('section', { class: 'card card-pad stack' },
    h('div', { class: 'sig-head' }, h('h2', { text: 'Messaggio' }), regenBtn),
    h('p', { class: 'muted small', text: 'Si aggiorna da solo con i dati qui sopra. Puoi anche correggerlo a mano prima di inviarlo.' }),
    msgBanner, msgArea,
    h('div', { class: 'btn-row' }, copyBtn, sendBtn));

  function amounts() {
    const ok = isIsoDate(q.checkIn) && isIsoDate(q.checkOut) && q.checkOut > q.checkIn;
    const n = ok ? daysBetween(q.checkIn, q.checkOut) : 0;
    return { ok, n };
  }

  function refresh() {
    const { ok, n } = amounts();
    // Avvisi sulle date
    const checks = ok ? quoteChecks(d.bookings, house, settings, { checkIn: q.checkIn, checkOut: q.checkOut, guests: q.guests, today: ui.today }) : [];
    checksBox.replaceChildren(...(ok ? checks.map((c) => h('div', { class: ['quote-check', c.level] },
      icon(c.level === 'ok' ? 'check' : 'alert', { size: 16 }), h('span', { text: c.text })))
      : [h('p', { class: 'muted', text: 'Scegli le date di arrivo e partenza.' })]));

    // Prezzo consigliato
    let sug = null;
    if (ok) {
      const hist = historyPrice(d.bookings, house.id, q.checkIn, q.checkOut, { windowDays: settings.window_days, today: ui.today });
      sug = suggestPrice(hist, { checkIn: q.checkIn, checkOut: q.checkOut, today: ui.today, settings });
      if (!sug) {
        suggestBox.replaceChildren(h('p', { class: 'muted', text: hist.count ? 'Lo storico non basta per un consiglio.'
          : `Nessun soggiorno degli anni passati tra il ${formatItDate(addDays(q.checkIn, -settings.window_days)).slice(0, 5)} e il ${formatItDate(addDays(q.checkOut, settings.window_days)).slice(0, 5)}: scrivi tu il prezzo. Lo storico si riempie caricando le prenotazioni degli anni scorsi.` }));
      } else {
        suggestBox.replaceChildren(
          h('div', { class: 'quote-suggest' },
            h('div', { class: 'quote-big', text: fmtEuro(sug.total) }),
            h('div', { class: 'muted', text: `${fmtEuro(sug.perNight)} a notte · ${n} ${n === 1 ? 'notte' : 'notti'}` })),
          h('ul', { class: 'quote-why' },
            h('li', { text: `Media degli anni scorsi nello stesso periodo: ${fmtEuro(hist.perNight)} a notte (${hist.count} ${hist.count === 1 ? 'soggiorno' : 'soggiorni'})` }),
            sug.adjustments.map((a) => h('li', { text: `${a.label}: ${a.pct > 0 ? '+' : '−'}${Math.abs(a.pct)}%` }))),
          h('details', { class: 'quote-hist' }, h('summary', { text: 'Vedi i soggiorni usati' }),
            h('ul', null, hist.stays.map((s) => h('li', null,
              h('span', { text: `${formatItDate(s.check_in)} → ${formatItDate(s.check_out)} · ${s.guests} pers. · ` }), chan(s.channel),
              h('span', { text: ` · ${fmtEuro(s.perNight)} a notte` })))),
            h('p', { class: 'muted small', text: 'Per Airbnb e Booking vale il prezzo registrato nella prenotazione.' })));
      }
    } else suggestBox.replaceChildren(h('p', { class: 'muted', text: 'Il consiglio compare quando scegli le date.' }));

    // Prezzo, acconto (se non cambiati a mano seguono il consiglio)
    if (!q.priceTouched) { q.price = sug ? centsToInput(sug.total) : q.price; priceIn.value = q.price; }
    const priceC = parseEuro(q.price);
    if (!q.depositTouched) { q.deposit = priceC ? centsToInput(depositFor(priceC, pct)) : ''; depositIn.value = q.deposit; }
    useSuggested.hidden = !(sug && (q.priceTouched || q.depositTouched));

    const tax = ok ? touristTax(q.checkIn, q.checkOut, q.guests, taxSet) : null;
    taxLine.textContent = tax ? `Tassa di soggiorno (a parte): ${explainTax(tax, q.guests)}` : '';

    // Messaggio
    if (!q.messageTouched) {
      const depositC = parseEuro(q.deposit);
      q.message = ok && priceC ? quoteMessage({
        lang: q.lang, name: q.name, checkIn: q.checkIn, checkOut: q.checkOut, guests: q.guests,
        price: priceC, deposit: depositC || 0, security: security(), linens: linens(), towels: towels(),
        extras: settings.extras.filter((x) => q.extras[x.id]).map((x) => ({ ...x, amount: extraAmount(x, { guests: q.guests, nights: n }) })),
        validUntil: addDays(ui.today, settings.validity_days), note: settings.note, note_en: settings.note_en,
      }, house, rules, taxSet) : '';
      msgArea.value = q.message;
      msgArea.placeholder = ok ? 'Scrivi il prezzo per preparare il messaggio.' : 'Scegli date e prezzo per preparare il messaggio.';
    }
  }

  function problems() {
    const { ok } = amounts();
    if (!ok) { setFieldError(isIsoDate(q.checkIn) ? dateOut : dateIn, isIsoDate(q.checkIn) ? 'La partenza deve essere dopo l’arrivo' : 'Scegli la data di arrivo'); return 'Scegli le date.'; }
    if (!(q.guests >= 1)) { setFieldError(guestsIn, 'Indica quante persone'); return 'Indica quante persone.'; }
    const p = parseEuro(q.price);
    if (!p) { setFieldError(priceIn, 'Scrivi il prezzo'); return 'Scrivi il prezzo del soggiorno.'; }
    const dep = parseEuro(q.deposit);
    if (dep === null || dep > p) { setFieldError(depositIn, 'Acconto non valido'); return 'Controlla l’acconto.'; }
    if (!q.message.trim()) return 'Il messaggio è vuoto.';
    return '';
  }

  function showBanner(text) { msgBanner.textContent = text; msgBanner.hidden = !text; }

  function send() {
    const err = problems();
    showBanner(err);
    if (err) return;
    let num = '';
    if (q.phone.trim()) {
      num = waNumber(q.phone);
      if (!num) { setFieldError(phoneIn, 'Numero non valido'); showBanner('Controlla il numero di telefono (o lascialo vuoto).'); return; }
    }
    const url = `https://wa.me/${num}?text=${encodeURIComponent(q.message)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function copy() {
    const err = problems();
    showBanner(err);
    if (err) return;
    try {
      await navigator.clipboard.writeText(q.message);
      ctx.toast('Testo copiato');
    } catch {
      msgArea.focus();
      msgArea.select();
      showBanner('Non riesco a copiare da solo: il testo è selezionato, usa Copia del menu.');
    }
  }

  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', { text: 'Preventivo' }), h('div', { class: 'sub', text: 'Prezzo consigliato e messaggio per WhatsApp. Non blocca le date e non si salva.' })),
    h('div', { class: 'btn-row' },
      ctx.syncChip(),
      h('button', { class: 'btn', type: 'button', onClick: () => { draft = fresh(); ctx.render(); } }, icon('refresh', { size: 16 }), 'Nuovo preventivo')));

  const switches = h('div', { class: 'btn-row' },
    segmented(d.houses.map((x) => ({ value: x.id, label: x.name, swatch: true, vars: houseVars(x) })), house.id, (id) => {
      // Cambiando casa: lenzuola, cauzione ed extra tornano quelli della nuova casa; il prezzo si ricalcola.
      Object.assign(q, { linens: null, towels: null, security: null, extras: {}, priceTouched: false, depositTouched: false, messageTouched: false });
      ctx.setHouse(id);
    }, 'Casa'));
  switches.style.marginBottom = '20px';

  const page = h('div', { vars: houseVars(house) }, head, switches,
    h('div', { class: 'quote-grid' },
      h('div', { class: 'stack' }, stayCard),
      h('div', { class: 'stack' },
        h('section', { class: 'card card-pad stack' }, h('h2', { text: 'Date' }), checksBox),
        priceCard)),
    h('div', { class: 'quote-msg-wrap' }, msgCard));
  if (q.messageTouched) msgArea.value = q.message;
  refresh();
  return page;
}
