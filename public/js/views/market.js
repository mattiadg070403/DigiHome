// Mercato (Apify): finestra delle impostazioni per casa (posizione, dotazioni, ricerca e scelta delle 10 case simili)
// e pezzi riusati dal listino e dal preventivo. La chiave di Apify non arriva mai qui: l'app sa solo se c'è.

import { h, icon } from '../dom.js';
import { field, openDialog, setFieldError } from '../ui.js';
import { fmtEuro } from '../../shared/money.js';
import { AMENITIES, MAX_SELECTED, amenityReport, checkMarketSettings, listingIdFromUrl, marketSettings, parseCoords } from '../../shared/market.js';

const fmtKm = (m) => (m === null || m === undefined ? '' : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} km`);
const when = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }) : '—');

/** Riassunto per Impostazioni → Case. */
export function marketSummary(ctx, house) {
  const d = ctx.store.data;
  const s = marketSettings(house);
  if (!ctx.store.info.apifyReady) return { text: 'Apify non collegato (manca la chiave in Cloudflare)', tone: 'warn' };
  if (s.lat === null) return { text: 'Posizione e dotazioni da impostare', tone: 'warn' };
  const n = (d.marketComps || []).filter((c) => c.house_id === house.id && c.selected).length;
  if (!n) return { text: 'Case simili da cercare', tone: 'warn' };
  const last = (d.marketPrices || []).filter((p) => p.house_id === house.id).reduce((m, p) => (p.checked_at > m ? p.checked_at : m), '');
  return { text: `${n} case simili · prezzi aggiornati ${last ? `il ${when(last)}` : 'a breve'}`, tone: 'ok' };
}

/** Finestra "Mercato" di una casa. */
export function marketSettingsDialog(ctx, house) {
  const { store } = ctx;
  const cur = marketSettings(house);
  const coords = h('input', { class: 'input', inputmode: 'decimal', autocomplete: 'off', placeholder: 'es. 40.0558, 17.9925', value: cur.lat !== null ? `${cur.lat}, ${cur.lon}` : '' });
  const radius = h('input', { class: 'input', inputmode: 'decimal', value: String(cur.radius_km).replace('.', ',') });
  const guests = h('input', { class: 'input', inputmode: 'numeric', value: cur.guests === null ? '' : String(cur.guests), placeholder: String(house.max_guests) });
  const bedrooms = h('input', { class: 'input', inputmode: 'numeric', value: cur.bedrooms === null ? '' : String(cur.bedrooms), placeholder: '–' });
  const query = h('input', { class: 'input', value: cur.query });
  const mine = new Set(cur.amenities);
  const amenBox = h('div', { class: 'mk-amen' }, Object.entries(AMENITIES).map(([k, a]) => h('label', { class: 'pl-check' },
    h('input', { type: 'checkbox', checked: mine.has(k), onChange: (e) => { if (e.target.checked) mine.add(k); else mine.delete(k); } }), h('span', { text: a.label }))));
  const compsBox = h('div', { class: 'stack acc-tight' });
  // Case scelte da Mattia: si incolla il link dell'annuncio (dal sito o dall'app di Airbnb, "Condividi → Copia link").
  const linkIn = h('input', { class: 'input', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https://www.airbnb.it/rooms/…', attrs: { 'aria-label': 'Link dell’annuncio su Airbnb' },
    onKeydown: (e) => { if (e.key === 'Enter') addLink(); } });
  async function addLink() {
    const id = listingIdFromUrl(linkIn.value);
    if (!id) { setFieldError(linkIn, 'Link non riconosciuto: deve contenere /rooms/ e un numero'); return; }
    setFieldError(linkIn, '');
    try {
      const r = await ctx.act('market.add', { house_id: house.id, url: linkIn.value.trim() }, { message: 'Casa aggiunta: titolo e dotazioni arrivano tra qualche minuto' });
      linkIn.value = '';
      touched = false;
      await store.load({ force: true });
      if (r && !r.selected) ctx.toast(`Aggiunta all’elenco ma non scelta: hai già ${MAX_SELECTED} case. Togline una e metti la spunta a questa.`, { bad: true });
      draw();
    } catch { /* messaggio già mostrato */ }
  }
  const addBox = h('div', { class: 'stack acc-tight' },
    h('div', { class: 'label', text: 'Aggiungi una casa che conosci, con il link di Airbnb' }),
    h('div', { class: 'field mk-add' }, h('div', { class: 'btn-row' }, linkIn, h('button', { class: 'btn small primary', type: 'button', text: 'Aggiungi', onClick: addLink })), h('div', { class: 'err', hidden: true })),
    h('p', { class: 'muted small', text: 'Sul telefono: apri l’annuncio nell’app di Airbnb → Condividi → Copia link, poi incollalo qui. Le case che aggiungi tu vengono prima di quelle trovate dalla ricerca.' }));
  const jobsLine = h('p', { class: 'muted small', attrs: { 'aria-live': 'polite' } });
  let picked = new Set(); // scelta in corso (insieme di annunci)
  let touched = false; // finché non si tocca niente, la scelta segue quella salvata

  const ready = store.info.apifyReady;
  const dlg = openDialog({
    title: `Mercato · ${house.name}`,
    wide: true,
    content: h('div', { class: 'stack' },
      ready ? null : h('div', { class: 'banner warn', text: 'Apify non è collegato: manca la chiave APIFY_TOKEN in Cloudflare (Workers & Pages → questo Worker → Settings → Variables and Secrets).' }),
      h('p', { class: 'muted small', text: 'Il gestionale confronta la casa con 10 case simili su Airbnb: prezzi e disponibilità settimana per settimana, dotazioni e spese a parte. Solo dati pubblici degli annunci.' }),
      h('h3', { text: 'La casa' }),
      h('div', { class: 'form-grid' },
        field('Posizione (coordinate)', coords, { full: true, hint: 'Su Google Maps tieni premuto sulla casa e copia i due numeri che compaiono (es. 40.0558, 17.9925)' }),
        field('Posti (ospiti)', guests, { hint: `Si confrontano case con al massimo 2 posti di differenza. Vuoto = ${house.max_guests}, il massimo della casa` }),
        field('Raggio della ricerca (km)', radius, { hint: 'Di solito 2–3 km' }),
        field('Camere da letto', bedrooms, { hint: 'Per trovare case della stessa grandezza' }),
        field('Dove cercare su Airbnb', query, { full: true })),
      h('div', { class: 'field' }, h('div', { class: 'label', text: 'Dotazioni della casa (per il confronto)' }), amenBox),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'button', text: 'Salva', onClick: () => save() })),
      h('h3', { text: 'Case simili' }),
      addBox,
      jobsLine,
      compsBox),
    actions: [h('button', { class: 'btn', type: 'button', text: 'Chiudi', onClick: () => dlg.close() })],
    onClose: () => { unsub(); clearInterval(timer); },
  });

  async function save({ quiet = false } = {}) {
    dlg.setBanner('');
    const c = coords.value.trim() ? parseCoords(coords.value) : { lat: null, lon: null };
    if (!c) { setFieldError(coords, 'Scrivi le coordinate come le copia Google Maps'); dlg.setBanner('Controlla la posizione.'); return false; }
    const input = { lat: c.lat, lon: c.lon, radius_km: Number(radius.value.replace(',', '.')), guests: guests.value.trim() === '' ? null : Number(guests.value), bedrooms: bedrooms.value.trim() === '' ? null : Number(bedrooms.value),
      amenities: [...mine], query: query.value };
    const r = checkMarketSettings(input);
    if (!r.ok) { dlg.setBanner(r.error); return false; }
    const h0 = store.data.houses.find((x) => x.id === house.id) || house;
    try {
      await ctx.act('house.update', { id: h0.id, version: h0.version, changes: { market_settings: r.value } }, { message: quiet ? undefined : 'Impostazioni del mercato salvate' });
      return true;
    } catch (e) {
      dlg.setBanner(e.message);
      return false;
    }
  }

  async function post(path) {
    try {
      const res = await store.request(path, { method: 'POST', body: { houseId: house.id }, timeout: 30000 });
      await store.load({ force: true });
      return res;
    } catch (e) {
      dlg.setBanner(e.message);
      return null;
    }
  }

  function draw() {
    const d = store.data;
    const comps = (d.marketComps || []).filter((c) => c.house_id === house.id);
    const jobs = (d.marketJobs || []).filter((j) => j.house_id === house.id);
    const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    const lastErr = jobs.find((j) => j.status === 'error');
    const lastPrice = (d.marketPrices || []).filter((p) => p.house_id === house.id).reduce((m, p) => (p.checked_at > m ? p.checked_at : m), '');
    jobsLine.textContent = [
      pending.length ? `In corso su Apify: ${pending.length} ${pending.length === 1 ? 'ricerca' : 'ricerche'} (i risultati arrivano da soli in pochi minuti).` : null,
      lastPrice ? `Prezzi aggiornati il ${when(lastPrice)}. Si aggiornano da soli una volta a settimana.` : null,
      lastErr && !pending.length ? `Ultimo errore: ${lastErr.error}` : null,
    ].filter(Boolean).join(' ');
    if (!touched) picked = new Set(comps.filter((c) => c.selected).map((c) => c.listing_id));
    const searchBtn = h('button', { class: 'btn small', type: 'button', disabled: !ready, onClick: async () => {
      if (!(await save({ quiet: true }))) return;
      const r = await post('/api/market/discover');
      if (r) ctx.toast('Ricerca avviata su Apify: tra qualche minuto compaiono le case simili');
      touched = false;
      draw();
    } }, icon('refresh', { size: 16 }), comps.length ? 'Cerca di nuovo' : 'Cerca case simili');
    if (!comps.length) {
      const lastSearch = jobs.find((j) => j.kind === 'search');
      const searching = lastSearch && (lastSearch.status === 'queued' || lastSearch.status === 'running');
      const text = searching ? 'Ricerca in corso: aspetta qualche minuto con la finestra aperta, le case compaiono qui da sole.'
        : lastSearch && lastSearch.status === 'done' ? 'La ricerca è finita ma nessuna casa corrisponde ai criteri: prova ad allargare il raggio (es. 5 km) o a lasciare vuote le camere, salva e cerca di nuovo.'
          : lastSearch && lastSearch.status === 'error' ? `La ricerca non è riuscita: ${lastSearch.error || 'errore di Apify'}.`
            : 'Aggiungi le tue case con il link qui sopra (fino a 10), oppure salva posizione e dotazioni e tocca "Cerca case simili": il gestionale propone le 15 più simili e sceglie le prime 10.';
      compsBox.replaceChildren(h('p', { class: ['small', lastSearch && lastSearch.status !== 'done' && !searching ? 'warn-text' : 'muted'], text }), searching ? null : h('div', null, searchBtn));
      return;
    }
    const count = h('strong', { text: `${picked.size} di ${MAX_SELECTED} scelte` });
    const rows = comps.map((c) => {
      const box = h('input', { type: 'checkbox', checked: picked.has(c.listing_id), attrs: { 'aria-label': `Usa ${c.title || c.listing_id} per il confronto` }, onChange: (e) => {
        if (e.target.checked && picked.size >= MAX_SELECTED) { e.target.checked = false; ctx.toast(`Al massimo ${MAX_SELECTED} case simili.`, { bad: true }); return; }
        touched = true;
        if (e.target.checked) picked.add(c.listing_id); else picked.delete(c.listing_id);
        count.textContent = `${picked.size} di ${MAX_SELECTED} scelte`;
      } });
      let am = [];
      try { am = JSON.parse(c.amenities || '[]'); } catch { am = []; }
      const manual = c.source === 'manuale';
      return h('label', { class: 'mk-comp' }, box,
        h('span', { class: 'mk-comp-main' },
          h('span', { class: 'mk-comp-title' },
            h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', text: c.title || `Annuncio ${c.listing_id}` }),
            manual ? h('span', { class: 'tag ok', text: 'scelta da te' }) : null,
            !c.title ? h('span', { class: 'muted small', text: 'dati in arrivo' }) : null,
            manual ? h('button', { class: 'btn ghost small danger', type: 'button', text: 'Togli', onClick: async (e) => {
              e.preventDefault();
              try { await ctx.act('market.remove', { house_id: house.id, listing_id: c.listing_id }, { message: 'Casa tolta' }); touched = false; await store.load({ force: true }); draw(); } catch { /* già mostrato */ }
            } }) : null),
          h('span', { class: 'muted small', text: [c.capacity ? `${c.capacity} ospiti` : null, c.bedrooms !== null && c.bedrooms !== undefined ? `${c.bedrooms} camere` : null, fmtKm(c.distance_m),
            c.rating ? `★ ${Number(c.rating).toLocaleString('it-IT', { maximumFractionDigits: 2 })}${c.reviews ? ` (${c.reviews})` : ''}` : null].filter(Boolean).join(' · ') }),
          am.length ? h('span', { class: 'muted small', text: am.map((k) => (AMENITIES[k] ? AMENITIES[k].label : k)).join(', ') }) : null));
    });
    compsBox.replaceChildren(
      h('div', { class: 'mk-comp-head' }, count, h('span', { class: 'muted small', text: 'Le più simili per prime. Tocca il titolo per vedere l’annuncio su Airbnb.' })),
      h('div', { class: 'mk-comps' }, rows),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small primary', type: 'button', text: 'Salva la scelta', onClick: async () => {
          try {
            await ctx.act('market.select', { house_id: house.id, listing_ids: [...picked] }, { message: 'Case simili salvate' });
            touched = false;
            await store.load({ force: true });
            draw();
          } catch { /* messaggio già mostrato */ }
        } }),
        h('button', { class: 'btn small', type: 'button', disabled: !ready, onClick: async () => {
          const r = await post('/api/market/refresh');
          if (r) ctx.toast('Aggiornamento dei prezzi avviato: le settimane arrivano un po’ alla volta');
          draw();
        } }, icon('refresh', { size: 16 }), 'Aggiorna i prezzi adesso'),
        searchBtn));
  }

  // Mentre la finestra è aperta e ci sono ricerche in corso, si controlla Apify ogni 20 secondi.
  const unsub = store.subscribe((kind) => { if (kind === 'data') draw(); });
  const timer = setInterval(async () => {
    const pending = (store.data.marketJobs || []).some((j) => j.house_id === house.id && (j.status === 'queued' || j.status === 'running'));
    if (!pending || dlg.closed) return;
    try { await store.request('/api/market/check', { method: 'POST', body: {}, timeout: 30000 }); await store.load({ force: true }); } catch { /* si riprova */ }
  }, 20000);
  draw();
  return dlg;
}

/** Scheda "Mercato" del listino: riassunto, dotazioni a confronto e consigli. */
export function marketCard(ctx, house) {
  const d = ctx.store.data;
  const s = marketSettings(house);
  const rep = amenityReport(d.marketComps || [], house.id, s, d.marketPrices || []);
  const isAdmin = d.me.role === 'admin';
  const open = isAdmin ? h('button', { class: 'btn small', type: 'button', text: 'Case simili e impostazioni', onClick: () => marketSettingsDialog(ctx, house) }) : null;
  if (!rep) {
    return h('section', { class: 'card card-pad stack' },
      h('div', { class: 'section-head acc-card-head' }, h('h2', { text: 'Mercato' }), open),
      h('p', { class: 'muted small', text: isAdmin ? 'Scegli 10 case simili su Airbnb per vedere qui prezzi, case già prenotate e dotazioni a confronto.' : 'Il confronto con le case simili non è ancora impostato.' }));
  }
  const last = (d.marketPrices || []).filter((p) => p.house_id === house.id).reduce((m, p) => (p.checked_at > m ? p.checked_at : m), '');
  return h('section', { class: 'card card-pad stack' },
    h('div', { class: 'section-head acc-card-head' }, h('h2', { text: 'Mercato' }), open),
    h('p', { class: 'muted small', text: `Confronto con ${rep.n} case simili su Airbnb${last ? ` · aggiornato il ${when(last)}` : ' · prezzi in arrivo'}. I prezzi delle case simili sono quelli che paga l'ospite per 7 notti (pulizie comprese), da confrontare con il tuo prezzo Airbnb.` }),
    rep.tips.length ? h('ul', { class: 'quote-why mk-tips' }, rep.tips.map((t) => h('li', { class: t.kind === 'forza' ? 'ok-text' : t.kind === 'manca' ? 'warn-text' : null, text: t.text }))) : null,
    h('details', { class: 'quote-hist' }, h('summary', { text: 'Dotazioni a confronto' }),
      h('div', { class: 'mk-amen-table' }, rep.rows.map((r) => h('div', { class: 'mk-amen-row' },
        h('span', { text: r.label }),
        h('span', { class: r.mine ? 'ok-text' : 'muted', text: r.mine ? 'Tu: sì' : 'Tu: no' }),
        h('span', { class: 'mk-bar' }, h('span', { class: 'mk-bar-fill', vars: { '--w': `${Math.round((r.count / r.n) * 100)}%` } })),
        h('span', { class: 'muted small', text: `${r.count} su ${r.n}` }))))));
}

export { fmtEuro };
