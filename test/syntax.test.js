// Controllo di sintassi di tutti i file dell'app (anche quelli che i test non importano): un errore di battitura
// in una pagina bloccherebbe l'app intera sul telefono.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function jsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('sintassi: tutti i file JavaScript dell’app e del server si leggono senza errori', () => {
  const files = [...jsFiles('public'), ...jsFiles('src')];
  assert.ok(files.length > 20);
  const bad = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad.push(`${f}: ${String(e.stderr).split('\n').find((l) => /Error/.test(l)) || 'errore'}`); }
  }
  assert.deepEqual(bad, []);
});
