import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp } from '../src/ops.js';
import { readState } from '../src/state.js';
import { todayRome } from '../public/shared/dates.js';
import { checkContractInfo } from '../public/shared/contract.js';
import { euroIt, isTaxCode, receiptBlocks, receiptFileName } from '../public/shared/receipt.js';
import { buildReceiptPdf } from '../public/js/pdf.js';

const op = (db, user, type, payload) => runOp(db, user, { opId: crypto.randomUUID(), type, payload });
const INFO = { landlord_sal: 'M', landlord_name: 'Mario Rossi', landlord_residence: 'Gallipoli, Via Prova 1', landlord_cf: 'RSSMRA70A01E506X',
  city: 'Gallipoli', address: 'Via di Prova n. 1', cin: 'IT075031C2PROVA0001' };

async function setup() {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', role: 'admin' });
  const collab = await addUser(db, { email: 'collab@example.invalid', role: 'collaboratore' });
  await db.prepare("UPDATE houses SET contract_info = ?, receipts_enabled = 1 WHERE id = 'faro-blu'").bind(JSON.stringify(INFO)).run();
  const mk = async (o = {}) => (await op(db, admin, 'booking.create', { booking: { house_id: 'faro-blu', channel: 'diretto', guest_name: 'Luca Verdi', guests: 4,
    check_in: '2030-07-06', check_out: '2030-07-13', total_cents: 210000, deposit_cents: 50000, deposit_paid: 1, ...o } })).record;
  return { db, admin, collab, mk };
}

test('ricevuta: solo saldo, numerazione progressiva per casa e anno, una sola per prenotazione', async () => {
  const { db, admin, collab, mk } = await setup();
  const b1 = await mk();
  const b2 = await mk({ check_in: '2030-07-13', check_out: '2030-07-20', deposit_paid: 0, deposit_cents: 0, total_cents: 6000 });
  const r1 = await op(db, collab, 'payreceipt.issue', { booking_id: b1.id }); // anche il collaboratore
  assert.equal(r1.record.number, 1);
  assert.equal(r1.record.year, Number(todayRome().slice(0, 4)));
  assert.equal(r1.record.amount_cents, 160000); // 2.100 − 500 di acconto già ricevuto
  const again = await op(db, admin, 'payreceipt.issue', { booking_id: b1.id });
  assert.equal(again.record.id, r1.record.id); // la stessa, niente doppioni
  const r2 = await op(db, admin, 'payreceipt.issue', { booking_id: b2.id });
  assert.equal(r2.record.number, 2);
  const data = JSON.parse(r1.record.data);
  assert.equal(data.landlord_cf, 'RSSMRA70A01E506X');
  assert.equal(data.guest_name, 'Luca Verdi');
  assert.equal((await readState(db, collab)).payReceipts.length, 2);
  assert.equal((await readState(db, admin)).payReceipts.length, 2);
});

test('ricevuta: rifiutata se spenta, non diretta, senza saldo o senza dati del locatore', async () => {
  const { db, admin, mk } = await setup();
  const airbnb = await mk({ channel: 'airbnb', deposit_cents: 0, deposit_paid: 0 });
  await assert.rejects(op(db, admin, 'payreceipt.issue', { booking_id: airbnb.id }), /solo per le prenotazioni dirette/);
  const paid = await mk({ check_in: '2030-08-03', check_out: '2030-08-10', deposit_cents: 210000, deposit_paid: 1 });
  await assert.rejects(op(db, admin, 'payreceipt.issue', { booking_id: paid.id }), /saldo/);
  const b = await mk({ check_in: '2030-09-07', check_out: '2030-09-14' });
  await db.prepare("UPDATE houses SET contract_info = '{}' WHERE id = 'faro-blu'").run();
  await assert.rejects(op(db, admin, 'payreceipt.issue', { booking_id: b.id }), /Dati del contratto/);
  await db.prepare("UPDATE houses SET receipts_enabled = 0 WHERE id = 'faro-blu'").run();
  await assert.rejects(op(db, admin, 'payreceipt.issue', { booking_id: b.id }), /non è attiva/);
});

test('ricevuta: testo in italiano e inglese, nessun riferimento alla marca da bollo, PDF valido', () => {
  const data = { ...INFO, guest_name: 'Luca Verdi', check_in: '2030-07-06', check_out: '2030-07-13', method: 'contanti', issued_on: '2030-07-06' };
  const r = { number: 3, year: 2030, amount_cents: 160000, data };
  const it = receiptBlocks(r, 'it').map((x) => x.text || x.label).join('\n');
  assert.match(it, /RICEVUTA n\. 3\/2030/);
  assert.match(it, /Il sottoscritto \*\*Mario Rossi\*\*, codice fiscale \*\*RSSMRA70A01E506X\*\*/);
  assert.match(it, /la somma di \*\*1\.600,00 €\*\* a saldo/);
  assert.match(it, /dal 06\/07\/2030 al 13\/07\/2030/);
  assert.match(it, /Pagamento: contanti\./);
  assert.doesNotMatch(it, /bollo/i); // tolta su richiesta di Mattia
  assert.match(it, /CIN IT075031C2PROVA0001/);
  const en = receiptBlocks(r, 'en').map((x) => x.text || x.label).join('\n');
  assert.match(en, /RECEIPT No\. 3\/2030/);
  assert.match(en, /€1,600\.00/);
  assert.match(en, /from 6 July 2030 to 13 July 2030/);
  assert.doesNotMatch(en, /stamp/i);
  assert.equal(euroIt(7747), '77,47 €');
  assert.equal(receiptFileName(r, 'Faro Blu', 'en'), 'Receipt 3-2030 Faro Blu - Verdi.pdf');
  const pdf = buildReceiptPdf({ blocks: receiptBlocks(r, 'it'), lang: 'it', title: 'Ricevuta 3/2030', issuedAt: '2030-07-06T10:00:00Z', houseName: 'Faro Blu' });
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.doesNotMatch(text, /Marca|bollo/);
});

test('codice fiscale del locatore: facoltativo, controllato', () => {
  assert.equal(isTaxCode('RSSMRA70A01E506X'), true);
  assert.equal(isTaxCode('RSSMRA70A01E506'), false);
  assert.equal(checkContractInfo({ ...INFO, landlord_cf: 'rssmra70a01e506x' }).value.landlord_cf, 'RSSMRA70A01E506X');
  assert.equal(checkContractInfo({ ...INFO, landlord_cf: '12345' }).ok, false);
  assert.equal(checkContractInfo({ ...INFO, landlord_cf: '' }).ok, true);
});
