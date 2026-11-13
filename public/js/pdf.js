// PDF del contratto firmato, creato sul dispositivo (nessuna libreria esterna, nessun invio a terzi).
// Formato A4, carattere Helvetica (incluso in ogni lettore PDF), firme incorporate come immagini JPEG.

import { base64ToBytes, jpegInfo, romeDateTime } from '../shared/contract.js';

const W = 595.28;
const H = 841.89;
const ML = 56;
const MR = 56;
const TOP = 64;
const BOTTOM = 70;
const TEXT_W = W - ML - MR;
const SIGN_H = 150; // spazio per le due firme con i nomi

// Larghezze dei caratteri Helvetica (codifica WinAnsi, dal codice 32 al 255), in millesimi del corpo.
const WIDTHS = {
  F1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350, 556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500],
  F2: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350, 556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556],
};

// Caratteri speciali della codifica WinAnsi (codici 128-159).
const SPECIAL = new Map([[0x20AC, 128], [0x201A, 130], [0x0192, 131], [0x201E, 132], [0x2026, 133], [0x2020, 134], [0x2021, 135], [0x02C6, 136],
  [0x2030, 137], [0x0160, 138], [0x2039, 139], [0x0152, 140], [0x017D, 142], [0x2018, 145], [0x2019, 146], [0x201C, 147], [0x201D, 148],
  [0x2022, 149], [0x2013, 150], [0x2014, 151], [0x02DC, 152], [0x2122, 153], [0x0161, 154], [0x203A, 155], [0x0153, 156], [0x017E, 158], [0x0178, 159],
  [0x2212, 45]]);

/** Testo → codici WinAnsi (i caratteri non stampabili diventano "?"). */
export function encode(text) {
  const out = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) out.push(c);
    else if (SPECIAL.has(c)) out.push(SPECIAL.get(c));
    else if (c === 9 || c === 10) out.push(32);
    else out.push(63);
  }
  return out;
}

function width(codes, font, size) {
  const w = WIDTHS[font];
  let sum = 0;
  for (const c of codes) sum += w[c - 32] || 556;
  return (sum * size) / 1000;
}

/** Stringa PDF letterale: parentesi e barre protette, byte non ASCII in ottale. */
function pdfString(codes) {
  let s = '(';
  for (const c of codes) {
    if (c === 40 || c === 41 || c === 92) s += `\\${String.fromCharCode(c)}`;
    else if (c < 32 || c > 126) s += `\\${c.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(c);
  }
  return `${s})`;
}

const num = (n) => (Math.round(n * 100) / 100).toString();

/** Divide un testo in righe che stanno nella larghezza data. */
function wrap(text, font, size, maxW) {
  const words = String(text).split(/ +/).filter(Boolean);
  const lines = [];
  let cur = [];
  const spaceW = width([32], font, size);
  let curW = 0;
  const push = () => { if (cur.length) lines.push(cur.join(' ')); cur = []; curW = 0; };
  for (let word of words) {
    let ww = width(encode(word), font, size);
    // Parola più lunga della riga (es. l'impronta): si spezza.
    while (ww > maxW) {
      push();
      let cut = word.length;
      while (cut > 1 && width(encode(word.slice(0, cut)), font, size) > maxW) cut -= 1;
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
      ww = width(encode(word), font, size);
    }
    if (!word) continue;
    const add = cur.length ? spaceW + ww : ww;
    if (curW + add > maxW && cur.length) push();
    curW += cur.length ? spaceW + ww : ww;
    cur.push(word);
  }
  push();
  return lines.length ? lines : [''];
}

const STYLE = {
  title: { font: 'F2', size: 13, lead: 17, before: 0, after: 10, align: 'center' },
  center: { font: 'F2', size: 10.5, lead: 14, before: 6, after: 6, align: 'center' },
  h: { font: 'F2', size: 10.5, lead: 14, before: 10, after: 3, align: 'left' },
  p: { font: 'F1', size: 10, lead: 13.4, before: 0, after: 5, align: 'justify' },
  li: { font: 'F1', size: 10, lead: 13.4, before: 0, after: 2.5, align: 'justify', indent: 16 },
  place: { font: 'F1', size: 10, lead: 13.4, before: 14, after: 6, align: 'left' },
  'privacy-h': { font: 'F2', size: 9.5, lead: 12.5, before: 0, after: 4, align: 'left' },
  privacy: { font: 'F1', size: 8.6, lead: 11.2, before: 0, after: 3.5, align: 'justify' },
};

/**
 * Crea il PDF del contratto. c: contratto completo (body, guest_sign, host_sign, signed_at, hash, house_name).
 * Restituisce i byte del file.
 */
export function buildPdf(c) {
  const pages = [];
  let ops = null;
  let y = 0;
  const newPage = () => { ops = []; pages.push(ops); y = H - TOP; };
  newPage();
  const ensure = (h) => { if (y - h < BOTTOM) newPage(); };

  const textLine = (str, x, yy, font, size, tw = 0) => {
    const codes = encode(str);
    ops.push(`BT /${font} ${num(size)} Tf ${tw ? `${num(tw)} Tw ` : ''}${num(x)} ${num(yy)} Td ${pdfString(codes)} Tj${tw ? ' 0 Tw' : ''} ET`);
  };

  const block = (b) => {
    const st = STYLE[b.t] || STYLE.p;
    const indent = st.indent || 0;
    const maxW = TEXT_W - indent;
    const lines = wrap(b.text || '', st.font, st.size, maxW);
    y -= st.before;
    // Titoli e frasi che introducono un elenco non restano da soli in fondo alla pagina;
    // luogo e data restano sulla stessa pagina delle firme.
    const keep = b.t === 'h' ? 30 : /:$/.test(b.text || '') ? st.lead * 2 : b.t === 'place' ? SIGN_H : 0;
    ensure(st.lead * Math.min(lines.length, 2) + keep);
    lines.forEach((line, i) => {
      ensure(st.lead);
      const base = y - st.size;
      const lw = width(encode(line), st.font, st.size);
      let x = ML + indent;
      let tw = 0;
      if (st.align === 'center') x = ML + (TEXT_W - lw) / 2;
      else if (st.align === 'justify' && i < lines.length - 1) {
        const spaces = (line.match(/ /g) || []).length;
        if (spaces) tw = Math.min((maxW - lw) / spaces, 6);
      }
      if (b.t === 'li' && i === 0) textLine('–', ML + 4, base, st.font, st.size);
      textLine(line, x, base, st.font, st.size, tw);
      y -= st.lead;
    });
    y -= st.after;
  };

  const blocks = Array.isArray(c.body) ? c.body.filter((b) => b.t !== 'sign') : [];
  const names = (Array.isArray(c.body) && c.body.find((b) => b.t === 'sign')) || {};
  const privacyAt = blocks.findIndex((b) => b.t === 'privacy-h');
  const main = privacyAt >= 0 ? blocks.slice(0, privacyAt) : blocks;
  const privacy = privacyAt >= 0 ? blocks.slice(privacyAt) : [];
  main.forEach(block);

  // Firme: le due colonne restano insieme sulla stessa pagina.
  const imgs = [c.host_sign, c.guest_sign].map((dataUrl, i) => {
    const bytes = base64ToBytes(String(dataUrl || '').split(',')[1] || '');
    const info = bytes && jpegInfo(bytes);
    return info ? { name: `Im${i + 1}`, bytes, info } : null;
  });
  const when = c.signed_at ? romeDateTime(c.signed_at) : null;
  const boxW = 210;
  const boxH = 74;
  ensure(SIGN_H);
  y -= 6;
  const cols = [{ label: 'IL LOCATORE', x: ML }, { label: 'IL CONDUTTORE', x: W - MR - boxW }];
  cols.forEach((col, i) => {
    textLine(col.label, col.x, y - 10, 'F2', 10);
    const img = imgs[i];
    const top = y - 18;
    if (img) {
      const scale = Math.min(boxW / img.info.width, boxH / img.info.height);
      const w = img.info.width * scale;
      const hh = img.info.height * scale;
      ops.push(`q ${num(w)} 0 0 ${num(hh)} ${num(col.x)} ${num(top - hh)} cm /${img.name} Do Q`);
    }
    ops.push(`0.6 G 0.5 w ${num(col.x)} ${num(top - boxH - 2)} m ${num(col.x + boxW)} ${num(top - boxH - 2)} l S 0 G`);
    const name = i === 0 ? names.host : names.guest;
    if (name) textLine(wrap(name, 'F1', 9, boxW)[0], col.x, top - boxH - 13, 'F1', 9);
  });
  y -= 18 + boxH + 20;
  if (when) {
    const note = `Firmato elettronicamente su dispositivo il ${when.date} alle ore ${when.time} (ora italiana).`;
    textLine(note, ML, y - 9, 'F1', 8.6);
    y -= 14;
  }
  y -= 10;

  if (privacy.length) {
    ensure(80);
    ops.push(`0.75 G 0.5 w ${num(ML)} ${num(y)} m ${num(W - MR)} ${num(y)} l S 0 G`);
    y -= 12;
    privacy.forEach(block);
  }

  // Piè di pagina: casa, impronta e numero di pagina.
  const total = pages.length;
  const footLeft = `Contratto di locazione turistica${c.house_name ? ` · ${c.house_name}` : ''}`;
  const hashLine = c.hash ? `Impronta SHA-256: ${c.hash}` : '';
  pages.forEach((p, i) => {
    ops = p;
    ops.push('0.45 g');
    textLine(footLeft, ML, 40, 'F1', 7.5);
    const pg = `Pagina ${i + 1} di ${total}`;
    textLine(pg, W - MR - width(encode(pg), 'F1', 7.5), 40, 'F1', 7.5);
    if (hashLine) textLine(hashLine, ML, 29, 'F1', 6.5);
    ops.push('0 g');
  });

  return assemble(pages, imgs.filter(Boolean), c);
}

/* ------------------------------ Scrittura del file ------------------------------ */

function latin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

function pdfDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function assemble(pages, imgs, c) {
  const chunks = [];
  let length = 0;
  const offsets = [];
  const put = (x) => {
    const bytes = typeof x === 'string' ? latin1(x) : x;
    chunks.push(bytes);
    length += bytes.length;
  };
  const obj = (n, body) => {
    offsets[n - 1] = length;
    put(`${n} 0 obj\n`);
    for (const part of [].concat(body)) put(part);
    put('\nendobj\n');
  };

  // Numeri degli oggetti: 1 catalogo, 2 pagine, 3-4 caratteri, 5 informazioni, poi immagini, poi pagine e contenuti.
  const imgStart = 6;
  const pageStart = imgStart + imgs.length;
  const pageIds = pages.map((_, i) => pageStart + i * 2);
  const xobjects = imgs.map((im, i) => `/${im.name} ${imgStart + i} 0 R`).join(' ');

  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  obj(5, `<< /Title ${pdfString(encode('Contratto di locazione turistica'))} /Producer (DigiHome) /CreationDate (${pdfDate(c.signed_at)}) >>`);
  imgs.forEach((im, i) => {
    const cs = im.info.components === 1 ? '/DeviceGray' : '/DeviceRGB';
    obj(imgStart + i, [`<< /Type /XObject /Subtype /Image /Width ${im.info.width} /Height ${im.info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`, im.bytes, '\nendstream']);
  });
  pages.forEach((ops, i) => {
    const content = ops.join('\n');
    obj(pageIds[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> /Contents ${pageIds[i] + 1} 0 R >>`);
    obj(pageIds[i] + 1, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
  });
  const xrefAt = length;
  const count = offsets.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  put(xref);
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let o = 0;
  for (const ch of chunks) { out.set(ch, o); o += ch.length; }
  return out;
}

/** Nome del file: "Contratto Faro Blu - Verdi - 10-07-2027.pdf" (solo caratteri semplici). */
export function pdfFileName(c) {
  const simple = (s) => String(s || '').normalize('NFD').replace(/[^A-Za-z0-9 -]+/g, '').replace(/\s+/g, ' ').trim();
  const surname = simple((c.guest && c.guest.name) || '').split(' ').slice(-1)[0] || 'ospite';
  const d = (c.check_in || '').split('-').reverse().join('-');
  return `Contratto ${simple(c.house_name) || 'casa'} - ${surname} - ${d}.pdf`;
}
