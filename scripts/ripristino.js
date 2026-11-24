#!/usr/bin/env node
// Ripristino della copia dei dati di DigiHome: trasforma i file .json scaricati da Impostazioni
// ("Scarica una copia dei dati": il file principale e quelli delle ricevute della Questura, uno per anno)
// nelle istruzioni SQL per un database D1 nuovo. Vedi src/restore.js e docs/TECNICO.md.
//
//   node scripts/ripristino.js digihome-produzione-AAAA-MM-GG.json digihome-produzione-AAAA-MM-GG-ricevute-*.json > ripristino.sql

import { readFileSync } from 'node:fs';
import { buildRestoreSql } from '../src/restore.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Uso: node scripts/ripristino.js <copia.json> [<ricevute-ANNO.json> …] > ripristino.sql');
  process.exit(2);
}
try {
  const all = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const main = all.filter((x) => x && x.kind !== 'ricevute');
  if (main.length !== 1) throw new Error('Serve esattamente un file principale della copia (quello senza "ricevute" nel nome)');
  const { sql, counts } = buildRestoreSql(main[0], all.filter((x) => x && x.kind === 'ricevute'));
  process.stdout.write(sql);
  console.error('Pronto. Righe per tabella:', Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', '));
} catch (e) {
  console.error(`Ripristino non preparato: ${e.message}`);
  process.exit(1);
}
