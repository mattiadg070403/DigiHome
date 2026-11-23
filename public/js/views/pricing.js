// Listino prezzi: per ogni settimana della stagione il netto che si vuole in tasca; prezzi per diretto, Airbnb e
// Booking calcolati dalle commissioni della contabilità; anno scorso, ritmo delle prenotazioni e suggerimenti.
// Solo una base per decidere (scelta di Mattia): niente stati delle settimane, niente spunte sui portali,
// nessun prezzo cambiato da solo. Lo modifica solo l'amministratore; i collaboratori lo vedono.

import { h, icon } from '../dom.js';
import { houseVars, segmented, confirmDialog, setFieldError } from '../ui.js';
import { addDays, daysBetween, fmtShort } from '../../shared/dates.js';
import { fmtEuro, parseEuro, centsToInput } from '../../shared/money.js';
import { channelRule, effectiveBp } from '../../shared/accounting.js';
import { MONTHS_LONG, WEEKDAYS, buildList, listWeeks, seasonYear, pricingSettings, weekMonth } from '../../shared/pricing.js';
import { marketAdvice, weekMarket } from '../../shared/market.js';
import { marketCard } from './market.js';

// Scelte della pagina che restano finché l'app è aperta.
const view = { year: null, house: null, toolsOpen: false };
// Netti scritti e non ancora salvati: un ridisegno (dati arrivati da un altro salvataggio) non li cancella.
const typing = new Map();

const CH_LABEL = { diretto: 'Diretto', airbnb: 'Airbnb', booking: 'Booking' };
const pctText = (bp) => `${(bp / 100).toLocaleString('it-IT', { maximumFractionDigits: 2 })}%`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const round10 = (c) => Math.round(c / 1000) * 1000;
/** "+8%" / "−12%" / "in linea": il tuo prezzo Airbnb rispetto alla mediana delle case simili libere. */
const mkDiff = (mine, med) => { const p = Math.round(((mine - med) / med) * 100); return Math.abs(p) < 3 ? 'in linea' : `${p > 0 ? '+' : '−'}${Math.abs(p)}%`; };

/** "sab 5 → sab 12 giu" */
function weekLabel(ws) {
  const a = fmtShort(ws).split(' ');
  const b = fmtShort(addDays(ws, 7)).split(' ');
  return a[2] === b[2] ? `${a[0]} ${a[1]} → ${b[0]} ${b[1]} ${b[2]}` : `${a.join(' ')} → ${b.join(' ')}`;
}

export function renderPricing(ctx, { tabs } = {}) {
  const { store, ui } = ctx;
  const d = store.data;
  const isAdmin = d.me.role === 'admin';
  const house = d.houses.find((x) => x.id === ui.houseId) || d.houses[0];
  const settings = pricingSettings(house);
  if (view.house !== house.id || !view.year) { view.house = house.id; view.year = seasonYear(ui.today, settings); }
  const year = view.year;
  const list = buildList({ bookings: d.bookings, prices: d.prices, extras: d.extras, house, year, today: ui.today });
  // Mercato (case simili su Airbnb): sintesi della settimana e consiglio, uniti ai suggerimenti del listino.
  for (const w of list.weeks) {
    w.market = weekMarket(d.marketPrices || [], d.marketComps || [], house.id, w.ws);
    if (!w.market || w.ws <= ui.today || w.sold > 0) continue;
    const adv = marketAdvice(w.market, { myAirbnbWeek: w.prices && w.prices.airbnb ? w.prices.airbnb.week : null, net: w.net, daysToArrival: daysBetween(ui.today, w.ws) });
    if (!adv) continue;
    const reason = { text: `Mercato: ${adv.text}`, pct: adv.target ? adv.pct : 0 };
    if (w.suggestion && !w.suggestion.missing) w.suggestion = { ...w.suggestion, reasons: [...w.suggestion.reasons, { ...reason, pct: 0 }] };
    else if (!w.suggestion) w.suggestion = adv.target ? { target: adv.target, pct: adv.pct, reasons: [reason], missing: false } : { target: null, pct: 0, reasons: [reason], missing: false };
  }

  async function save(changes, message) {
    try {
      await ctx.act('price.set', { house_id: house.id, year, weeks: changes }, { message, quiet: !message });
      for (const k of Object.keys(changes)) typing.delete(`${house.id}:${k}`);
      return true;
    } catch {
      return false; // il motivo lo mostra già il messaggio d'errore
    }
  }

  /* ------------------------------ Testata ------------------------------ */
  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', { text: 'Listino' }),
      h('div', { class: 'sub', text: 'Scrivi quanto vuoi in tasca per ogni settimana: i prezzi per diretto, Airbnb e Booking si calcolano da soli.' })),
    h('div', { class: 'btn-row' }, ctx.syncChip()));

  const yearNav = h('div', { class: 'pl-year', attrs: { role: 'group', 'aria-label': 'Stagione' } },
    h('button', { class: 'btn ghost icon-only', type: 'button', attrs: { 'aria-label': `Stagione ${year - 1}` }, onClick: () => { view.year = year - 1; ctx.render(); } }, icon('back')),
    h('strong', { text: `Stagione ${year}` }),
    h('button', { class: 'btn ghost icon-only', type: 'button', attrs: { 'aria-label': `Stagione ${year + 1}` }, onClick: () => { view.year = year + 1; ctx.render(); } }, icon('chevron')));

  const switches = h('div', { class: 'btn-row pl-switches' },
    segmented(d.houses.map((x) => ({ value: x.id, label: x.name, swatch: true, vars: houseVars(x) })), house.id, (id) => ctx.setHouse(id), 'Casa'),
    yearNav);

  /* ------------------------------ Ritmo ------------------------------ */
  const STATUS = { avanti: ['Più veloce', 'ok'], in_linea: ['In linea', 'neutral'], indietro: ['Più lento', 'warn'] };
  const unknownLy = list.pace.some((m) => m.lyUnknown > 0);
  const paceCard = h('section', { class: 'card card-pad stack' },
    h('div', { class: 'section-head acc-card-head' }, h('h2', { text: 'Ritmo delle prenotazioni' })),
    h('p', { class: 'muted small', text: `Notti già vendute per mese, confrontate con quelle che l’anno scorso a questa data erano già prenotate.` }),
    h('div', { class: 'pl-pace' }, list.pace.map((m) => {
      const st = m.status ? STATUS[m.status] : null;
      return h('div', { class: ['pl-month', m.status] },
        h('div', { class: 'pl-month-head' }, h('span', { class: 'acc-tile-label', text: cap(MONTHS_LONG[m.month - 1]) }),
          st ? h('span', { class: ['tag', st[1]], text: st[0] }) : null),
        h('div', { class: 'pl-month-value', text: `${m.pct}%` }),
        h('div', { class: 'acc-goal-bar', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'acc-goal-fill pl-fill', vars: { '--w': `${Math.min(100, m.pct)}%` } })),
        h('div', { class: 'acc-tile-sub', text: m.comparable ? `L’anno scorso a oggi ${m.lyPct}% · alla fine ${m.lyFinalPct}%` : m.lyFinalPct ? 'Anno scorso: manca quando sono arrivate' : 'Anno scorso: niente da confrontare' }));
    })),
    unknownLy ? h('p', { class: 'muted small', text: 'Per alcune prenotazioni dell’anno scorso non si sa quando sono arrivate (sono state inserite dopo): il confronto sarà completo dalla prossima stagione, oppure importando un file con la data della prenotazione.' }) : null);

  /* ------------------------------ Suggerimenti ------------------------------ */
  const sugWeeks = list.weeks.filter((w) => w.suggestion);
  const sugCard = sugWeeks.length ? h('section', { class: 'card card-pad stack pl-sugs' },
    h('div', { class: 'section-head acc-card-head' }, h('h2', { text: `Da valutare (${sugWeeks.length})` })),
    h('p', { class: 'muted small', text: 'Solo consigli: nessun prezzo cambia da solo.' }),
    sugWeeks.map((w) => suggestionRow(w))) : null;

  function suggestionRow(w) {
    const s = w.suggestion;
    return h('div', { class: 'pl-sug' },
      h('div', { class: 'pl-sug-main' },
        h('a', { class: 'pl-sug-week', href: `#pl-${w.ws}`, text: weekLabel(w.ws), onClick: (e) => { e.preventDefault(); focusWeek(w.ws); } }),
        s.target === null ? null : h('div', { class: 'pl-sug-price' },
          s.missing ? h('span', { text: `Proposto ${fmtEuro(s.target)} in tasca` })
            : [h('span', { class: 'muted', text: fmtEuro(w.net) }), h('span', { text: ' → ' }), h('strong', { text: fmtEuro(s.target) }),
              h('span', { class: ['tag', s.pct > 0 ? 'ok' : 'warn'], text: `${s.pct > 0 ? '+' : '−'}${Math.abs(s.pct)}%` })]),
        h('ul', { class: 'pl-why' }, s.reasons.map((r) => h('li', { text: r.pct ? `${r.text}: ${r.pct > 0 ? '+' : '−'}${Math.abs(r.pct)}%` : r.text })))),
      isAdmin && s.target !== null ? h('button', { class: 'btn small', type: 'button', text: 'Usa questo', onClick: () => save({ [w.ws]: s.target }, `${weekLabel(w.ws)}: ${fmtEuro(s.target)} in tasca`) }) : null);
  }

  function focusWeek(ws) {
    const el = document.getElementById(`pl-${ws}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = el.querySelector('input');
    if (input) setTimeout(() => input.focus({ preventScroll: true }), 350);
  }

  /* ------------------------------ Strumenti veloci ------------------------------ */
  let tools = null;
  if (isAdmin) {
    const lyList = listWeeks(d.prices, house.id, year - 1);
    // Anno scorso: dal listino se c'era, altrimenti da quanto incassato; se manca, due anni fa.
    const fromLy = (w) => lyList[addDays(w.ws, -364)] || (w.ly ? w.ly.net : w.ly2 ? w.ly2.net : null);
    const copyPct = h('input', { class: 'input pl-pct', inputmode: 'numeric', value: '0', attrs: { 'aria-label': 'Percentuale da aggiungere all’anno scorso' } });
    const copyAll = h('input', { type: 'checkbox' });
    const months = [];
    for (let m = settings.months[0]; m <= settings.months[1]; m++) months.push(m);
    let fixMonth = 'all';
    const fixSeg = h('div');
    const drawFix = () => fixSeg.replaceChildren(segmented([{ value: 'all', label: 'Tutta' }, ...months.map((m) => ({ value: String(m), label: cap(MONTHS_LONG[m - 1]).slice(0, 3) }))],
      fixMonth, (v) => { fixMonth = v; drawFix(); }, 'Periodo da correggere'));
    drawFix();
    const fixPct = h('input', { class: 'input pl-pct', inputmode: 'text', placeholder: '+5 o −5', attrs: { 'aria-label': 'Percentuale di correzione' } });
    const readPct = (el, { allowZero = true } = {}) => {
      const n = Number(String(el.value).trim().replace('−', '-').replace('%', '').replace(',', '.'));
      if (String(el.value).trim() === '' || !Number.isFinite(n) || n < -50 || n > 100 || (!allowZero && n === 0)) {
        el.setAttribute('aria-invalid', 'true');
        ctx.toast('Scrivi una percentuale da −50 a +100 (es. 5 oppure −5).', { bad: true });
        return null;
      }
      el.removeAttribute('aria-invalid');
      return n;
    };
    async function copyLastYear() {
      const pct = readPct(copyPct);
      if (pct === null) return;
      const changes = {};
      for (const w of list.weeks) {
        const base = fromLy(w);
        if (!base || (w.net && !copyAll.checked)) continue;
        changes[w.ws] = Math.max(100, round10(base * (1 + pct / 100)));
      }
      const n = Object.keys(changes).length;
      if (!n) { ctx.toast(copyAll.checked ? 'Per questa stagione non c’è niente dell’anno scorso da copiare.' : 'Non ci sono settimane vuote con un prezzo dell’anno scorso.', { bad: true }); return; }
      const replaced = list.weeks.filter((w) => w.net && changes[w.ws]).length;
      if (replaced && !(await confirmDialog({ title: 'Sostituire i prezzi già scritti?', text: `${replaced} ${replaced === 1 ? 'settimana ha' : 'settimane hanno'} già un prezzo: verrà sostituito con quello dell’anno scorso${pct ? ` ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%` : ''}.`, okLabel: 'Sostituisci' }))) return;
      await save(changes, `${n} ${n === 1 ? 'settimana compilata' : 'settimane compilate'} dall’anno scorso`);
    }
    async function fixPeriod() {
      const pct = readPct(fixPct, { allowZero: false });
      if (pct === null) return;
      const changes = {};
      for (const w of list.weeks) {
        if (!w.net || (fixMonth !== 'all' && weekMonth(w.ws) !== Number(fixMonth))) continue;
        changes[w.ws] = Math.max(100, round10(w.net * (1 + pct / 100)));
      }
      const n = Object.keys(changes).length;
      if (!n) { ctx.toast('Nel periodo scelto non ci sono settimane con un prezzo.', { bad: true }); return; }
      const what = fixMonth === 'all' ? 'tutta la stagione' : MONTHS_LONG[Number(fixMonth) - 1];
      if (!(await confirmDialog({ title: 'Correggere i prezzi?', text: `${n} ${n === 1 ? 'settimana' : 'settimane'} di ${what}: ${pct > 0 ? '+' : '−'}${Math.abs(pct)}% (arrotondato a 10 €).`, okLabel: 'Correggi' }))) return;
      await save(changes, `Prezzi di ${what}: ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`);
    }
    tools = h('details', { class: 'card pl-tools', open: view.toolsOpen, onToggle: (e) => { view.toolsOpen = e.target.open; } },
      h('summary', { class: 'card-pad' }, h('strong', { text: 'Strumenti veloci' }), h('span', { class: 'muted small', text: 'Copia dall’anno scorso, correggi un periodo' })),
      h('div', { class: 'card-pad stack pl-tools-body' },
        h('div', { class: 'stack acc-tight' },
          h('h3', { text: 'Parti dall’anno scorso' }),
          h('p', { class: 'muted small', text: 'Per ogni settimana il netto dell’anno scorso (dal listino, se c’era, altrimenti da quanto hai incassato; se manca, quello di due anni fa), più la percentuale che scegli.' }),
          h('div', { class: 'pl-tool-row' },
            h('label', { class: 'pl-inline' }, h('span', { text: 'Aggiungi %' }), copyPct),
            h('label', { class: 'pl-check' }, copyAll, h('span', { text: 'anche le settimane già compilate' })),
            h('button', { class: 'btn small', type: 'button', text: 'Copia l’anno scorso', onClick: copyLastYear }))),
        h('div', { class: 'stack acc-tight' },
          h('h3', { text: 'Correggi un periodo' }),
          fixSeg,
          h('div', { class: 'pl-tool-row' },
            h('label', { class: 'pl-inline' }, h('span', { text: 'Percentuale' }), fixPct),
            h('button', { class: 'btn small', type: 'button', text: 'Applica', onClick: fixPeriod })))));
  }

  /* ------------------------------ Settimane ------------------------------ */
  const rows = list.weeks.map((w) => weekRow(w));

  function weekRow(w) {
    const key = `${house.id}:${w.ws}`;
    const shown = typing.has(key) ? typing.get(key) : centsToInput(w.net ?? 0);
    let input = null;
    if (isAdmin) {
      input = h('input', { class: 'input pl-net', inputmode: 'decimal', value: shown, placeholder: w.ly ? centsToInput(round10(w.ly.net)) : '–',
        dataset: { key: `pl-${w.ws}` }, attrs: { 'aria-label': `In tasca per la settimana ${weekLabel(w.ws)}` },
        onInput: (e) => { typing.set(key, e.target.value); setFieldError(input, ''); },
        onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
        onChange: async (e) => {
          const raw = String(e.target.value).trim();
          const c = raw === '' ? null : parseEuro(raw);
          if (raw !== '' && (c === null || c < 100)) { setFieldError(input, 'Importo non valido'); return; }
          if ((c ?? null) === (w.net ?? null)) { typing.delete(key); return; }
          await save({ [w.ws]: c });
        } });
    }
    const vsLy = w.net && w.ly ? Math.round(((w.net - w.ly.net) / w.ly.net) * 100) : null;
    const lyText = w.ly ? fmtEuro(round10(w.ly.net)) : '—';
    const lySub = w.ly ? [w.ly.nights < 7 ? `${w.ly.nights} notti su 7` : null, w.ly2 ? `2 anni fa ${fmtEuro(round10(w.ly2.net))}` : null].filter(Boolean).join(' · ') : (w.ly2 ? `2 anni fa ${fmtEuro(round10(w.ly2.net))}` : '');
    const priceCells = ['diretto', 'airbnb', 'booking'].map((ch) => {
      const p = w.prices && w.prices[ch];
      return h('div', { class: ['pl-price', ch] },
        h('span', { class: 'pl-ch' }, h('span', { class: ['acc-key', ch] }), CH_LABEL[ch]),
        p ? h('strong', { class: 'pl-night', text: `${fmtEuro(p.night)}` }) : h('span', { class: 'muted', text: '—' }),
        p ? h('span', { class: 'pl-week muted', text: p.discount ? `con lo sconto ${p.discount}% l’ospite paga ${fmtEuro(p.guestNight)}` : `${fmtEuro(p.week)} a settimana` }) : null);
    });
    const s = w.suggestion;
    return h('div', { class: ['pl-row', s && 'has-sug'], id: `pl-${w.ws}` },
      h('div', { class: 'pl-when' }, h('strong', { text: weekLabel(w.ws) }),
        s ? h('span', { class: ['tag', s.missing ? 'neutral' : s.pct > 0 ? 'ok' : 'warn'], text: s.missing ? 'Manca il prezzo' : `Suggerito ${fmtEuro(s.target)}` }) : null),
      h('div', { class: 'pl-ly' }, h('span', { class: 'pl-cap', text: 'Anno scorso' }), h('span', { class: 'pl-ly-val', text: lyText }), lySub ? h('span', { class: 'muted small', text: lySub }) : null,
        w.market ? h('span', { class: 'pl-mk small' }, h('span', { class: 'pl-mk-label', text: 'Mercato ' }),
          w.market.median ? `${fmtEuro(Math.round(w.market.median / 1000) * 1000)} · ` : '',
          h('span', { class: w.market.takenPct >= 70 ? 'ok-text' : w.market.takenPct <= 30 ? 'warn-text' : null, text: `${w.market.taken}/${w.market.checked} prenotate` }),
          w.market.median && w.prices && w.prices.airbnb ? h('span', { class: 'muted', text: ` · tu ${mkDiff(w.prices.airbnb.week, w.market.median)}` }) : null) : null),
      h('div', { class: 'pl-mine field' }, h('span', { class: 'pl-cap', text: 'In tasca (settimana)' }),
        isAdmin ? h('div', { class: 'pl-net-wrap' }, input, h('span', { class: 'pl-eur', text: '€' })) : h('strong', { text: w.net ? fmtEuro(w.net) : '—' }),
        vsLy !== null ? h('span', { class: ['small', vsLy > 0 ? 'ok-text' : vsLy < 0 ? 'warn-text' : 'muted'], text: vsLy === 0 ? 'come l’anno scorso' : `${vsLy > 0 ? '+' : '−'}${Math.abs(vsLy)}% sull’anno scorso` }) : null,
        h('div', { class: 'err', hidden: true })),
      h('div', { class: 'pl-prices' }, h('span', { class: 'pl-cap pl-prices-cap', text: 'Prezzo da mettere, a notte' }), priceCells));
  }

  // Commissioni valide all'inizio della stagione (quelle della contabilità).
  const first = list.weeks[0] ? list.weeks[0].ws : `${year}-06-01`;
  const commission = (ch) => pctText(effectiveBp(channelRule(list.acc, ch, first)));
  const disc = settings.discounts;
  const howCard = h('section', { class: 'card card-pad stack pl-how' },
    h('h2', { text: 'Come si calcola' }),
    h('ul', { class: 'quote-why' },
      h('li', { text: `Diretto: niente commissione, solo la cedolare (${pctText(list.acc.cedolare_bp)}).` }),
      h('li', { text: `Airbnb: commissione ${commission('airbnb')} (IVA compresa) più la cedolare.${disc.airbnb ? ` Sconto attivo ${disc.airbnb}%: il prezzo da inserire è più alto, dopo lo sconto torna giusto.` : ''}` }),
      h('li', { text: `Booking: commissione ${commission('booking')} più la cedolare.${disc.booking ? ` Sconto attivo ${disc.booking}%: il prezzo da inserire è più alto, dopo lo sconto torna giusto.` : ''}` }),
      h('li', { text: 'Il prezzo a notte è arrotondato all’euro in su: in tasca non resta mai meno di quanto hai scritto.' })),
    h('p', { class: 'muted small', text: `Le percentuali sono quelle di Impostazioni → Case → Contabilità: se le cambi lì, cambia anche il listino. Settimane da ${WEEKDAYS[settings.week_start]}; regole dei suggerimenti in Impostazioni → Case → Listino.` }));

  const page = h('div', { vars: houseVars(house) }, head, tabs || null, switches,
    h('div', { class: 'stack pl-top' }, paceCard, sugCard, marketCard(ctx, house), tools),
    h('section', { class: 'card pl-list', attrs: { 'aria-label': `Settimane della stagione ${year}` } },
      h('div', { class: 'pl-row pl-head', attrs: { 'aria-hidden': 'true' } },
        h('span', { text: 'Settimana' }), h('span', { text: 'Anno scorso (in tasca)' }), h('span', { text: 'In tasca' }), h('span', { text: 'Prezzo da mettere, a notte' })),
      rows),
    howCard);
  return page;
}
