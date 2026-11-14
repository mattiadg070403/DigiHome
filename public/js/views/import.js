// Importazione delle prenotazioni passate da un vecchio foglio Excel (.xlsx) o CSV.
// Il file si legge sul dispositivo; si scelgono le colonne, si vede l'anteprima, poi si importa a blocchi.
// Le date già occupate si saltano (doppioni). Solo l'amministratore.

import { h, icon, newId } from '../dom.js';
import { field, openDialog, switchRow, chan, confirmDialog } from '../ui.js';
import { formatItDate } from '../../shared/dates.js';
import { fmtEuro } from '../../shared/money.js';
import { IMPORT_FIELDS, buildImport, guessMapping, headerRow, markDuplicates } from '../../shared/importer.js';
import { readSpreadsheet } from '../xlsx.js';

const CHUNK = 50;

export function importBlock(ctx) {
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small', text: 'Prenotazioni degli anni passati da un vecchio file Excel o CSV: servono per il prezzo consigliato dei preventivi.' }),
    h('div', null, h('button', { class: 'btn small', type: 'button', onClick: () => importDialog(ctx) }, icon('plus', { size: 16 }), 'Importa da Excel')));
}

function importDialog(ctx) {
  const { store } = ctx;
  const houses = store.data.houses;
  const st = { sheets: null, sheet: 0, header: 0, mapping: {}, fixedHouse: '', fixedChannel: '', withNames: false, items: [], busy: false };

  const fileIn = h('input', { type: 'file', accept: '.xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', id: newId(),
    onChange: (e) => load(e.target.files && e.target.files[0]) });
  fileIn.classList.add('file-hidden');
  const step1 = h('div', { class: 'stack' },
    h('p', { text: 'Scegli il file (.xlsx o .csv). Resta sul dispositivo: al gestionale vanno solo le colonne che scegli qui sotto.' }),
    h('div', null, h('label', { class: 'btn', for: fileIn.id }, icon('folder', { size: 16 }), 'Scegli il file'), fileIn));
  const mapBox = h('div', { class: 'stack' });
  const previewBox = h('div', { class: 'stack' });
  const goBtn = h('button', { class: 'btn primary', type: 'button', text: 'Importa', disabled: true, onClick: run });

  const dlg = openDialog({
    title: 'Importa prenotazioni passate',
    wide: true,
    content: h('div', { class: 'stack import-dialog' }, step1, mapBox, previewBox),
    actions: [h('button', { class: 'btn', type: 'button', text: 'Chiudi', onClick: () => dlg.close() }), goBtn],
    canClose: async () => !st.busy || confirmDialog({ title: 'Importazione in corso', text: 'Se chiudi, l’importazione continua finché c’è connessione; quelle già importate restano.', okLabel: 'Chiudi lo stesso' }),
  });

  async function load(file) {
    dlg.setBanner('');
    mapBox.replaceChildren(h('p', { class: 'muted', text: `Leggo ${file ? file.name : 'il file'}…` }));
    previewBox.replaceChildren();
    try {
      st.sheets = await readSpreadsheet(file);
      st.sheet = 0;
      setupSheet();
    } catch (e) {
      mapBox.replaceChildren();
      dlg.setBanner(e.message || 'Non riesco a leggere il file.');
    }
  }

  function setupSheet() {
    const rows = st.sheets[st.sheet].rows;
    st.header = headerRow(rows);
    st.mapping = guessMapping((rows[st.header] || []).map((x) => (x === null ? '' : String(x))));
    drawMapping();
    refresh();
  }

  function drawMapping() {
    const rows = st.sheets[st.sheet].rows;
    const headers = (rows[st.header] || []).map((x, i) => (x === null || String(x).trim() === '' ? `Colonna ${i + 1}` : String(x)));
    const colSelect = (key) => h('select', { class: 'input', onChange: (e) => { st.mapping[key] = e.target.value === '' ? null : Number(e.target.value); refresh(); } },
      h('option', { value: '', text: '— nessuna —', selected: st.mapping[key] === null }),
      headers.map((name, i) => h('option', { value: String(i), text: name, selected: st.mapping[key] === i })));
    const fixedSel = (key, options) => h('select', { class: 'input', onChange: (e) => { st[key] = e.target.value; refresh(); } },
      options.map(([v, t]) => h('option', { value: v, text: t, selected: st[key] === v })));
    mapBox.replaceChildren(
      st.sheets.length > 1 ? field('Foglio', h('select', { class: 'input', onChange: (e) => { st.sheet = Number(e.target.value); setupSheet(); } },
        st.sheets.map((s, i) => h('option', { value: String(i), text: s.name, selected: i === st.sheet })))) : null,
      h('h3', { text: 'Quale colonna è…' }),
      h('p', { class: 'muted small', text: `Intestazioni trovate alla riga ${st.header + 1}. Controlla gli abbinamenti: quelli proposti si basano sui nomi delle colonne.` }),
      h('div', { class: 'form-grid' },
        Object.entries(IMPORT_FIELDS).filter(([k]) => !['house', 'channel', 'guest_name', 'phone'].includes(k))
          .map(([k, f]) => field(`${f.label}${f.required ? '' : ' (facoltativo)'}`, colSelect(k))),
        field('Casa', colSelect('house'), { hint: 'Colonna con il nome della casa, oppure scegli sotto una casa per tutte' }),
        field('Tutte di una casa', fixedSel('fixedHouse', [['', 'No, dalla colonna'], ...houses.map((x) => [x.id, x.name])])),
        field('Canale', colSelect('channel'), { hint: 'Airbnb, Booking; tutto il resto conta come diretto' }),
        field('Tutte dello stesso canale', fixedSel('fixedChannel', [['', 'No, dalla colonna'], ['diretto', 'Diretto'], ['airbnb', 'Airbnb'], ['booking', 'Booking']]))),
      switchRow('Importa anche nome e telefono degli ospiti', { checked: st.withNames, onChange: (c) => { st.withNames = c; drawNames(); refresh(); },
        hint: 'Per il prezzo consigliato non servono: senza, le prenotazioni si chiamano "Ospite (importato)".' }),
      namesBox);
    drawNames();
  }
  const namesBox = h('div', { class: 'form-grid' });
  function drawNames() {
    if (!st.sheets) return;
    const rows = st.sheets[st.sheet].rows;
    const headers = (rows[st.header] || []).map((x, i) => (x === null || String(x).trim() === '' ? `Colonna ${i + 1}` : String(x)));
    const sel = (key) => h('select', { class: 'input', onChange: (e) => { st.mapping[key] = e.target.value === '' ? null : Number(e.target.value); refresh(); } },
      h('option', { value: '', text: '— nessuna —', selected: st.mapping[key] === null }),
      headers.map((name, i) => h('option', { value: String(i), text: name, selected: st.mapping[key] === i })));
    namesBox.replaceChildren(...(st.withNames ? [field('Nome dell’ospite', sel('guest_name')), field('Telefono', sel('phone'))] : []));
  }

  function refresh() {
    if (!st.sheets) return;
    const rows = st.sheets[st.sheet].rows;
    st.items = markDuplicates(buildImport(rows, {
      mapping: st.mapping, header: st.header, houses, fixedHouse: st.fixedHouse || null, fixedChannel: st.fixedChannel || null, withNames: st.withNames,
    }), store.data.bookings);
    const ready = st.items.filter((x) => x.ok && !x.duplicate);
    const dup = st.items.filter((x) => x.duplicate);
    const bad = st.items.filter((x) => !x.ok);
    goBtn.disabled = !ready.length || st.busy;
    goBtn.textContent = ready.length ? `Importa ${ready.length} ${ready.length === 1 ? 'prenotazione' : 'prenotazioni'}` : 'Importa';
    const name = (id) => houses.find((x) => x.id === id)?.name || id;
    previewBox.replaceChildren(
      h('h3', { text: 'Anteprima' }),
      h('p', { text: `${ready.length} pronte · ${dup.length} già nel gestionale (si saltano) · ${bad.length} con problemi` }),
      ready.length ? h('div', { class: 'import-list' }, ready.slice(0, 30).map((x) => h('div', { class: 'import-row' },
        h('span', { text: `Riga ${x.line}` }),
        h('span', { text: `${name(x.row.house_id)} · ${formatItDate(x.row.check_in)} → ${formatItDate(x.row.check_out)} · ${x.row.guests} pers.` }),
        chan(x.row.channel),
        h('strong', { text: fmtEuro(x.row.total_cents) })))) : null,
      ready.length > 30 ? h('p', { class: 'muted small', text: `…e altre ${ready.length - 30}.` }) : null,
      bad.length ? h('details', { class: 'quote-hist' }, h('summary', { text: `Righe con problemi (${bad.length})` }),
        h('ul', null, bad.slice(0, 100).map((x) => h('li', { text: `Riga ${x.line}: ${x.error}` })))) : null);
  }

  async function run() {
    const ready = st.items.filter((x) => x.ok && !x.duplicate);
    if (!ready.length || st.busy) return;
    st.busy = true;
    goBtn.disabled = true;
    dlg.setBanner('');
    let imported = 0;
    let skipped = 0;
    try {
      for (let i = 0; i < ready.length; i += CHUNK) {
        goBtn.textContent = `Importo… ${Math.min(i + CHUNK, ready.length)} di ${ready.length}`;
        const res = await ctx.act('booking.import', { rows: ready.slice(i, i + CHUNK).map((x) => x.row) }, { quiet: true });
        imported += res.imported || 0;
        skipped += (res.skipped || []).length;
      }
      await store.load({ force: true });
      st.busy = false;
      refresh();
      dlg.setBanner('');
      previewBox.prepend(h('div', { class: 'banner ok', text: `${imported === 1 ? 'Importata 1 prenotazione' : `Importate ${imported} prenotazioni`}${skipped ? `, ${skipped} saltate (date già occupate o dati non validi)` : ''}.` }));
    } catch (e) {
      st.busy = false;
      await store.load({ force: true }).catch(() => {});
      refresh();
      dlg.setBanner(`${e.message || 'Importazione interrotta.'} Importate finora: ${imported}. Puoi riprovare: quelle già importate si saltano.`);
    }
  }
}
