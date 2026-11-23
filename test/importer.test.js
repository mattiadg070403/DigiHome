import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, addUser } from './d1.js';
import { runOp, OpError } from '../src/ops.js';
import { buildImport, guessMapping, headerRow, markDuplicates, toCents, toChannel, toIsoDate } from '../public/shared/importer.js';
import { readSpreadsheet } from '../public/js/xlsx.js';

const HOUSES = [{ id: 'isola-bella', name: 'Isola Bella' }, { id: 'faro-blu', name: 'Faro Blu' }];
const op = () => crypto.randomUUID();
const fileOf = (path, name) => {
  const buf = readFileSync(new URL(path, import.meta.url));
  return { name, size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
};

test('conversioni: date di Excel e scritte, importi, canali', () => {
  assert.equal(toIsoDate(45870), '2025-08-01');
  assert.equal(toIsoDate('15/07/2025'), '2025-07-15');
  assert.equal(toIsoDate('15-07-25'), '2025-07-15');
  assert.equal(toIsoDate('2025-07-15 00:00:00'), '2025-07-15');
  assert.equal(toIsoDate('31/02/2025'), null);
  assert.equal(toIsoDate('domani'), null);
  assert.equal(toCents(2450.5), 245050);
  assert.equal(toCents('1.650,00 €'), 165000);
  assert.equal(toCents('1650 euro'), 165000);
  assert.equal(toCents('gratis'), null);
  assert.equal(toChannel('Booking.com'), 'booking');
  assert.equal(toChannel('AIRBNB'), 'airbnb');
  assert.equal(toChannel('privato'), 'diretto');
});

test('foglio Excel vero (.xlsx): fogli, intestazioni, abbinamento colonne, anteprima, doppioni', async () => {
  const sheets = await readSpreadsheet(fileOf('./fixtures/storico.xlsx', 'storico.xlsx'));
  assert.deepEqual(sheets.map((s) => s.name), ['Prenotazioni 2025', 'Note']);
  const rows = sheets[0].rows;
  const header = headerRow(rows);
  assert.equal(header, 1);
  const mapping = guessMapping(rows[header].map(String));
  assert.deepEqual(mapping, { check_in: 1, check_out: 2, nights: null, house: 0, channel: 4, guests: 3, total: 5, guest_name: 6, phone: 7, booked_on: null });
  const items = markDuplicates(buildImport(rows, { mapping, header, houses: HOUSES, withNames: false }), []);
  const ok = items.filter((x) => x.ok && !x.duplicate);
  assert.equal(ok.length, 3);
  assert.deepEqual(ok[0].row, { house_id: 'faro-blu', channel: 'airbnb', guest_name: 'Ospite (importato)', phone: null, guests: 8, check_in: '2025-08-01', check_out: '2025-08-08', total_cents: 210000, booked_on: null });
  assert.equal(ok[1].row.channel, 'diretto');
  assert.equal(ok[1].row.total_cents, 165000);
  assert.equal(ok[2].row.total_cents, 245050);
  assert.equal(items.find((x) => x.line === 6).duplicate, true); // si sovrappone alla riga 5
  assert.deepEqual(items.filter((x) => !x.ok).map((x) => [x.line, x.error]), [[7, 'casa non riconosciuta'], [9, 'data di partenza mancante o non valida']]);
  // Con i nomi
  const named = buildImport(rows, { mapping, header, houses: HOUSES, withNames: true }).find((x) => x.line === 3);
  assert.equal(named.row.guest_name, 'Mario Prova');
  assert.equal(named.row.phone, '+39 333 0000000');
});

test('CSV con punto e virgola, virgolette e notti al posto della partenza', async () => {
  const csv = '﻿Arrivo;Notti;Prezzo;Persone\n"01/08/2024";7;"1.400,00";6\n10/08/2024;3;600;2\n';
  const sheets = await readSpreadsheet({ name: 'a.csv', size: csv.length, arrayBuffer: async () => new TextEncoder().encode(csv).buffer });
  const rows = sheets[0].rows;
  const mapping = guessMapping(rows[0].map(String));
  const items = buildImport(rows, { mapping, header: 0, houses: HOUSES, fixedHouse: 'faro-blu', fixedChannel: 'diretto' });
  assert.deepEqual(items.map((x) => [x.row.check_in, x.row.check_out, x.row.total_cents, x.row.guests]),
    [['2024-08-01', '2024-08-08', 140000, 6], ['2024-08-10', '2024-08-13', 60000, 2]]);
});

test('file non validi: vecchio .xls, zip rovinato', async () => {
  await assert.rejects(readSpreadsheet({ name: 'a.xls', size: 4, arrayBuffer: async () => new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer }), /\.xls/);
  await assert.rejects(readSpreadsheet({ name: 'a.xlsx', size: 30, arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 3, 4, ...new Array(26).fill(0)]).buffer }), /Excel/);
});

test('server: importazione solo per l’amministratore, stati giusti, doppioni saltati, ripetibile', async () => {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', name: 'Mattia', role: 'admin' });
  const collab = await addUser(db, { email: 'collab@example.invalid', name: 'Collab', role: 'collaboratore' });
  const rows = [
    { house_id: 'faro-blu', channel: 'airbnb', guest_name: '', guests: 12, check_in: '2025-08-01', check_out: '2025-08-08', total_cents: 210000 },
    { house_id: 'faro-blu', channel: 'diretto', guests: 2, check_in: '2025-08-05', check_out: '2025-08-07', total_cents: 50000 },
    { house_id: 'casa-x', channel: 'diretto', guests: 2, check_in: '2025-09-05', check_out: '2025-09-07', total_cents: 50000 },
    { house_id: 'isola-bella', channel: 'diretto', guests: 2, check_in: '2025-09-07', check_out: '2025-09-05', total_cents: 50000 },
  ];
  await assert.rejects(runOp(db, collab, { opId: op(), type: 'booking.import', payload: { rows } }), OpError);
  const id = op();
  const r = await runOp(db, admin, { opId: id, type: 'booking.import', payload: { rows } });
  assert.equal(r.imported, 1);
  assert.deepEqual(r.skipped.map((x) => x.index), [1, 2, 3]);
  assert.match(r.skipped[0].reason, /già occupate/);
  const b = await db.prepare("SELECT * FROM bookings WHERE check_in = '2025-08-01'").first();
  assert.equal(b.stage, 'chiusa');
  assert.equal(b.guest_name, 'Ospite (importato)');
  assert.equal(b.guests, 12); // lo storico può superare il massimo di oggi
  const again = await runOp(db, admin, { opId: id, type: 'booking.import', payload: { rows } });
  assert.equal(again.replay, true);
  assert.equal(again.imported, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bookings').first()).n, 1);
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'booking.import', payload: { rows: new Array(101).fill(rows[0]) } }), /100/);
});
