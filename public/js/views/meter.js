// Contatore della luce al check-in e al check-out.
// Il display del contatore mostra tre fasce (A1, A2, A3): si scrivono a mano, il gestionale le somma,
// fa i conti dei kWh compresi e prepara il messaggio per l'ospite (da copiare o da aprire in WhatsApp).

import { h, icon } from '../dom.js';
import { houseVars, field, setFieldError, openDialog, segmented, switchRow } from '../ui.js';
import { fmtEuro } from '../../shared/money.js';
import { parseContractInfo } from '../../shared/contract.js';
import { BANDS, bandsOf, fmtKwh, meterCalc, meterExtraLabel, meterMessage, parseKwh } from '../../shared/meter.js';
import { waNumber } from './contact.js';

/** kWh compresi e prezzo della casa (per i collaboratori senza i dati personali del locatore). */
export function meterRules(house) {
  if (!house) return {};
  if (house.contract_info) return parseContractInfo(house);
  try { return JSON.parse(house.contract_public || '{}') || {}; } catch { return {}; }
}

/** Riga breve per la scheda: "arrivo 12.345 · partenza 12.600 kWh · 255 kWh usati". */
export function meterSummary(b, house) {
  if (!Number.isInteger(b.meter_start) && !Number.isInteger(b.meter_end)) return null;
  const c = meterCalc(b, meterRules(house));
  const parts = [];
  if (Number.isInteger(b.meter_start)) parts.push(`arrivo ${fmtKwh(b.meter_start)} kWh`);
  if (Number.isInteger(b.meter_end)) parts.push(`partenza ${fmtKwh(b.meter_end)} kWh`);
  if (c.used !== null) parts.push(`${fmtKwh(c.used)} kWh usati${c.extra ? `, ${fmtKwh(c.extra)} in più (${fmtEuro(c.cost)})` : ''}`);
  return parts.join(' · ');
}

/** Tre caselle A1, A2, A3 con il totale sotto. */
function bandInputs(label, saved, onChange) {
  const values = (bandsOf(saved) || [null, null, null]).map((x) => (Number.isInteger(x) ? fmtKwh(x) : ''));
  const total = h('div', { class: 'meter-total' });
  const inputs = BANDS.map((name, i) => h('input', { class: 'input meter-input', inputmode: 'decimal', autocomplete: 'off', value: values[i],
    placeholder: '0', attrs: { 'aria-label': `${label}: fascia ${name} in kWh` },
    onInput: (e) => { values[i] = e.target.value; setFieldError(inputs[i], ''); draw(); onChange(); } }));
  const parsed = () => values.map((x) => (String(x).trim() ? parseKwh(x) : null));
  function draw() {
    const p = parsed();
    total.textContent = p.every((x) => Number.isInteger(x)) ? `Totale: ${fmtKwh(p[0] + p[1] + p[2])} kWh` : 'Totale: scrivi le tre fasce';
  }
  draw();
  const el = h('div', { class: 'stack meter-group' },
    h('div', { class: 'label', text: label }),
    h('div', { class: 'meter-bands' }, BANDS.map((name, i) => field(name, inputs[i]))),
    total);
  return {
    el,
    get empty() { return values.every((x) => !String(x).trim()); },
    /** [a1, a2, a3] in decimi di kWh, oppure { error }. */
    read() {
      const p = parsed();
      for (let i = 0; i < 3; i++) {
        if (p[i] === null) { setFieldError(inputs[i], String(values[i]).trim() ? 'Numero non valido' : 'Scrivi il valore'); return { error: `${label}: controlla la fascia ${BANDS[i]}.` }; }
      }
      return { bands: p };
    },
    peek() { const p = parsed(); return p.every((x) => Number.isInteger(x)) ? p : null; },
  };
}

/**
 * Finestra della lettura. which: 'start' (check-in) o 'end' (check-out).
 * Alla partenza si vede (e si può correggere) anche la lettura di arrivo.
 */
export function openMeter(ctx, b, which) {
  const { store } = ctx;
  const house = store.data.houses.find((x) => x.id === b.house_id);
  const rules = meterRules(house);
  const direct = b.channel === 'diretto';
  const v = { lang: 'it', addExtra: false };
  let saving = false;

  const startG = bandInputs(which === 'end' ? 'Lettura all’arrivo' : 'Lettura del contatore', b.meter_start_bands, () => update());
  const endG = which === 'end' ? bandInputs('Lettura alla partenza', b.meter_end_bands, () => update()) : null;
  const calcBox = h('div', { class: 'stack meter-calc' });
  const extraBox = h('div');
  const langBox = h('div');
  const drawLang = () => langBox.replaceChildren(segmented([{ value: 'it', label: 'Italiano' }, { value: 'en', label: 'English' }], v.lang, (x) => { v.lang = x; drawLang(); }, 'Lingua del messaggio'));
  drawLang();

  /** Prenotazione con le letture scritte adesso (per conti e messaggio). */
  function draft() {
    const now = new Date().toISOString();
    const out = { ...b };
    const s = startG.peek();
    if (s) {
      const changed = JSON.stringify(s) !== JSON.stringify(bandsOf(b.meter_start_bands));
      Object.assign(out, { meter_start: s[0] + s[1] + s[2], meter_start_bands: JSON.stringify(s), meter_start_at: changed || !b.meter_start_at ? now : b.meter_start_at });
    } else if (startG.empty) Object.assign(out, { meter_start: null, meter_start_bands: null });
    if (endG) {
      const e = endG.peek();
      if (e) {
        const changed = JSON.stringify(e) !== JSON.stringify(bandsOf(b.meter_end_bands));
        Object.assign(out, { meter_end: e[0] + e[1] + e[2], meter_end_bands: JSON.stringify(e), meter_end_at: changed || !b.meter_end_at ? now : b.meter_end_at });
      } else if (endG.empty) Object.assign(out, { meter_end: null, meter_end_bands: null });
    }
    return out;
  }

  function update() {
    const d = draft();
    const c = meterCalc(d, rules);
    const lines = [];
    if (c.included === null) lines.push('Per questa casa la luce è tutta compresa (Impostazioni → Case → Dati del contratto).');
    else {
      lines.push(`Compresi ${c.perDay} kWh al giorno × ${c.nights} notti = ${fmtKwh(c.included)} kWh. Oltre: ${fmtEuro(rules.kwh_price_cents || 0)} a kWh.`);
      if (c.limit !== null) lines.push(`Senza costi in più fino a ${fmtKwh(c.limit)} kWh di totale sul contatore.`);
    }
    if (c.used !== null) lines.push(c.extra ? `Consumo ${fmtKwh(c.used)} kWh: ${fmtKwh(c.extra)} kWh in più = ${fmtEuro(c.cost)}${direct ? ' (si aggiunge da solo agli extra da incassare)' : ''}.` : `Consumo ${fmtKwh(c.used)} kWh: niente da pagare in più.`);
    calcBox.replaceChildren(...lines.map((t, i) => h('p', { class: i === lines.length - 1 && c.used !== null && c.extra ? 'meter-due' : 'muted', text: t })));
    // Airbnb e Booking: i kWh in più si aggiungono agli extra solo se lo decidi.
    extraBox.replaceChildren(!direct && c.cost > 0
      ? switchRow(`Aggiungi ${fmtEuro(c.cost)} tra gli extra da incassare`, { checked: v.addExtra, onChange: (x) => { v.addExtra = x; },
        hint: `Prenotazione ${b.channel === 'airbnb' ? 'Airbnb' : 'Booking'}: decidi tu se chiedere i kWh in più.` })
      : '');
  }

  /** Controlli: restituisce { start, end } (fasce o null) oppure { error }. */
  function collect() {
    let start = null;
    let end = null;
    if (which === 'start' || !startG.empty) {
      const r = startG.read();
      if (r.error) return { error: r.error };
      start = r.bands;
    }
    if (endG) {
      const r = endG.read();
      if (r.error) return { error: r.error };
      end = r.bands;
      if (start && end[0] + end[1] + end[2] < start[0] + start[1] + start[2]) return { error: 'Il totale alla partenza è più basso di quello all’arrivo: controlla i numeri.' };
    }
    return { start, end };
  }

  /** Copia o invio: va fatto SUBITO dentro il tocco (dopo un'attesa l'iPad lo blocca). */
  function deliver(how, d) {
    const text = meterMessage(which, d, rules, v.lang);
    if (how === 'copy') {
      navigator.clipboard.writeText(text).then(() => ctx.toast('Messaggio copiato: incollalo nella chat dell’ospite'))
        .catch(() => ctx.toast('Non sono riuscito a copiare il messaggio'));
    } else if (how === 'wa') {
      window.open(`https://wa.me/${waNumber(b.phone) || ''}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
    }
  }

  async function save(how) {
    if (saving) return;
    dlg.setBanner('');
    const r = collect();
    if (r.error) { dlg.setBanner(r.error); return; }
    const d = draft();
    deliver(how, d);
    saving = true;
    try {
      const same = (a, json) => JSON.stringify(a) === JSON.stringify(bandsOf(json));
      const ops = [];
      if (r.start && !same(r.start, b.meter_start_bands)) ops.push(['start', r.start]);
      if (endG && r.end && !same(r.end, b.meter_end_bands)) ops.push(['end', r.end]);
      // Se l'arrivo corretto supera la vecchia partenza, prima la partenza (il server controlla l'ordine).
      if (ops.length === 2 && Number.isInteger(b.meter_end) && d.meter_start > b.meter_end) ops.reverse();
      for (const [w, bands] of ops) await ctx.act('booking.meter', { id: b.id, which: w, bands }, { quiet: true });
      if (!direct && v.addExtra) {
        const c = meterCalc(d, rules);
        if (c.cost > 0) await ctx.act('extra.add', { bookingId: b.id, extra: { kind: 'altro', label: `Luce: ${meterExtraLabel(c)}`, amount_cents: c.cost, paid: 0 } }, { quiet: true });
      }
      if (how !== 'copy') ctx.toast(ops.length ? 'Lettura salvata' : 'Nessuna modifica');
      dlg.close();
    } catch (e) {
      saving = false;
      dlg.setBanner(e.message || 'Lettura non salvata: riprova.');
    }
  }

  const dlg = openDialog({
    title: `Contatore della luce · ${which === 'start' ? 'arrivo' : 'partenza'}`,
    content: h('div', { class: 'stack', vars: houseVars(house) },
      h('p', { class: 'muted', text: 'Scrivi le tre fasce del display (A1, A2, A3): il totale si calcola da solo.' }),
      startG.el,
      endG ? endG.el : null,
      calcBox,
      extraBox,
      h('h3', { text: 'Messaggio per l’ospite' }),
      h('div', { class: 'field' }, h('div', { class: 'label', text: 'Lingua' }), langBox),
      h('p', { class: 'muted small', text: '"Salva e copia" copia il messaggio con le tre fasce e il totale: poi lo incolli nella chat. "WhatsApp" apre direttamente la chat dell’ospite.' })),
    actions: [
      h('button', { class: 'btn', type: 'button', text: 'Salva', onClick: () => save(null) }),
      h('button', { class: 'btn', type: 'button', onClick: () => save('wa') }, icon('chat', { size: 16 }), 'Salva e apri WhatsApp'),
      h('button', { class: 'btn house', type: 'button', text: 'Salva e copia il messaggio', onClick: () => save('copy') }),
    ],
  });
  for (const [k, val] of Object.entries(houseVars(house))) dlg.el.style.setProperty(k, val);
  update();
  return dlg;
}
