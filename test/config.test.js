import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Legge un file .jsonc togliendo i commenti (// a inizio riga o dopo uno spazio, fuori dalle stringhe usate qui).
function jsonc(path) {
  const raw = readFileSync(new URL(path, import.meta.url), 'utf8');
  return JSON.parse(raw.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/,\s*\/\/.*$/, ',').replace(/\s\/\/ .*$/, '')).join('\n'));
}

test('versione definitiva separata da quella di prova e senza dati di prova', () => {
  const prova = jsonc('../wrangler.jsonc');
  const prod = jsonc('../produzione/wrangler.jsonc');
  assert.equal(prova.name, 'digihome-prova');
  assert.equal(prod.name, 'digihome');
  assert.equal(prod.vars.ALLOW_DEMO, 'false');
  assert.equal(prod.vars.APP_ENV, 'produzione');
  assert.notEqual(prod.d1_databases[0].database_name, prova.d1_databases[0].database_name);
  assert.notEqual(prod.d1_databases[0].database_id, prova.d1_databases[0].database_id);
  assert.equal(prod.main, '../src/worker.js');
  assert.equal(prod.assets.directory, '../public');
  assert.equal(prod.d1_databases[0].migrations_dir, '../migrations');
  assert.equal(prod.preview_urls, false);
  assert.equal(prod.keep_vars, true);
  assert.deepEqual(prod.triggers.crons, prova.triggers.crons);
});
