#!/usr/bin/env node
// Ripristino della copia dei dati di DigiHome: trasforma il file .json scaricato da Impostazioni
// ("Scarica una copia dei dati") nelle istruzioni SQL per un database D1 nuovo. Vedi src/restore.js.
//
//   node scripts/ripristino.js digihome-produzione-AAAA-MM-GG.json > ripristino.sql

import { readFileSync } from 'node:fs';
import { buildRestoreSql } from '../src/restore.js';

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/ripristino.js <copia.json> > ripristino.sql');
  process.exit(2);
}
try {
  const { sql, counts } = buildRestoreSql(JSON.parse(readFileSync(file, 'utf8')));
  process.stdout.write(sql);
  console.error('Pronto. Righe per tabella:', Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', '));
} catch (e) {
  console.error(`Ripristino non preparato: ${e.message}`);
  process.exit(1);
}
