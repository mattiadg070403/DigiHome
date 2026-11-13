import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, addUser } from './d1.js';
import { runOp, OpError, purgeContracts, readContract, contractDraft } from '../src/ops.js';
import { readState, readHistory, readExport } from '../src/state.js';
import { addDays, todayRome } from '../public/shared/dates.js';
import {
  buildContract, checkContractInfo, checkGuest, checkSignature, cleanText, contractMissing, contractText, hashInput,
  isCodiceFiscale, jpegInfo, base64ToBytes, purgeDate, sha256Hex, guestParagraph,
} from '../public/shared/contract.js';
import { buildPdf } from '../public/js/pdf.js';

const T = todayRome();
const op = () => crypto.randomUUID();
const SIGN = `data:image/jpeg;base64,${readFileSync(new URL('./fixtures/firma.jpg', import.meta.url)).toString('base64')}`;

const LANDLORD = {
  landlord_sal: 'M', landlord_name: 'Mario Rossi', landlord_birth_place: 'Lecce', landlord_birth_date: '1970-05-01',
  landlord_residence: 'Gallipoli, Via di Prova 1', landlord_role: 'usufruttuario',
};
const GUEST = { sal: 'F', name: 'Anna Verdi', birth_place: 'Milano', birth_date: '1990-02-03', residence: 'Milano, Via Prova 2',
  tax_code: '', doc_number: 'CA12345AB' };

function booking(over = {}) {
  return {
    house_id: 'faro-blu', channel: 'diretto', guest_name: 'Anna Verdi', phone: '+39 000 000', guests: 4,
    check_in: addDays(T, 10), check_out: addDays(T, 17), total_cents: 100000, deposit_cents: 30000,
    deposit_paid: true, security_cents: 30000, linens: true, towels: false, ...over,
  };
}

async function setup({ landlord = true } = {}) {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', name: 'Mattia', role: 'admin' });
  const collab = await addUser(db, { email: 'collab@example.invalid', name: 'Collab', role: 'collaboratore' });
  if (landlord) {
    const h = await db.prepare("SELECT * FROM houses WHERE id = 'faro-blu'").first();
    const info = { ...JSON.parse(h.contract_info), ...LANDLORD };
    await runOp(db, admin, { opId: op(), type: 'house.update', payload: { id: 'faro-blu', version: h.version, changes: { contract_info: info } } });
  }
  const b = (await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking() } })).record;
  return { db, admin, collab, b };
}

const signPayload = (b, over = {}) => ({ id: crypto.randomUUID(), booking_id: b.id, accepted: true, guest: GUEST, guest_sign: SIGN, host_sign: SIGN, ...over });

async function expectOpError(promise, code, re) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof OpError, `atteso OpError, ottenuto ${e}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

/* ------------------------------ Regole comuni ------------------------------ */

test('codice fiscale: controllo del carattere finale e omocodia', () => {
  assert.equal(isCodiceFiscale('RSSMRA70A01H501S'), true);
  assert.equal(isCodiceFiscale('rssmra70a01h501s'), true);
  assert.equal(isCodiceFiscale('RSSMRA70A01H501A'), false);
  assert.equal(isCodiceFiscale('RSSMRA70A01H50'), false);
  assert.equal(isCodiceFiscale('RSSMRAVLALMHRLMS'.slice(0, 16)), false);
});

test('testi: accenti latini sì, alfabeti non stampabili no, invisibili tolti', () => {
  assert.equal(cleanText('  Jürgen   Müller '), 'Jürgen Müller');
  assert.equal(cleanText('Łukasz Wałęsa'), 'Lukasz Walesa');
  assert.equal(cleanText('Ana​Maria'), 'AnaMaria');
  assert.equal(cleanText('Иван'), null);
  assert.equal(cleanText('riga1\n\n\n\nriga2', { multiline: true }), 'riga1\n\nriga2');
});

test('dati dell’ospite: maggiorenne, C.F. facoltativo ma valido, documento', () => {
  assert.equal(checkGuest(GUEST, T).ok, true);
  assert.equal(checkGuest({ ...GUEST, tax_code: 'rssmra70a01h501s' }, T).value.tax_code, 'RSSMRA70A01H501S');
  assert.equal(checkGuest({ ...GUEST, tax_code: 'RSSMRA70A01H501A' }, T).field, 'tax_code');
  assert.equal(checkGuest({ ...GUEST, birth_date: addDays(T, -365 * 10) }, T).field, 'birth_date');
  assert.equal(checkGuest({ ...GUEST, doc_number: '<x>' }, T).field, 'doc_number');
  assert.equal(checkGuest({ ...GUEST, name: 'Иван Петров' }, T).field, 'name');
});

test('dati del contratto della casa: controlli e cosa manca', () => {
  assert.equal(checkContractInfo({ cin: 'XX123' }).field, 'cin');
  assert.equal(checkContractInfo({ kwh_day: 30 }).field, 'kwh_price_cents');
  assert.equal(checkContractInfo({ landlord_role: 'altro' }).field, 'landlord_role');
  const ok = checkContractInfo({ ...LANDLORD, city: 'Gallipoli', address: 'Via X 1', description: 'piano terra', cin: 'it075031c200088528' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.cin, 'IT075031C200088528');
  assert.deepEqual(contractMissing(ok.value), []);
  assert.ok(contractMissing({}).length >= 8);
});

test('testo del contratto: niente importo totale, acconto, biancheria per prenotazione, tassa a parte', () => {
  const house = { checkin_time: '14:00', checkout_time: '10:00' };
  const info = { ...LANDLORD, city: 'Gallipoli', address: 'Via X 1', description: 'piano terra', cin: 'IT075031C200088528', kwh_day: 30, kwh_price_cents: 40, advance_pct: 30 };
  const b = { check_in: '2027-07-10', check_out: '2027-07-17', guests: 4, total_cents: 123456, security_cents: 0, linens: 1, towels: 0 };
  const text = contractText(buildContract({ house, info, booking: b, guest: GUEST, signedAt: '2027-07-10T13:05:00Z' }));
  assert.doesNotMatch(text, /1\.234,56/);
  assert.doesNotMatch(text, /gas/i);
  assert.doesNotMatch(text, /Airbnb|Booking/);
  assert.match(text, /circa il 30% del corrispettivo/);
  assert.match(text, /non è rimborsabile/);
  assert.match(text, /biancheria da letto\./);
  assert.match(text, /Non sono compresi gli asciugamani/);
  assert.match(text, /tassa di soggiorno non è compresa/);
  assert.match(text, /non è previsto il versamento di un deposito cauzionale/);
  assert.match(text, /30 kWh/);
  assert.match(text, /0,40 €/);
  assert.match(text, /4 persone/);
  assert.match(text, /La Sig\.ra Anna Verdi, nata a Milano il 03\/02\/1990/);
  assert.match(text, /Gallipoli, lì 10\/07\/2027/);
  assert.match(text, /usufruttuario dell’immobile/);
  assert.match(text, /Art\. 18 – Accettazione/);
  // Con cauzione e asciugamani
  const t2 = contractText(buildContract({ house, info, booking: { ...b, security_cents: 30000, towels: 1 } }));
  assert.match(t2, /deposito cauzionale la somma di 300 €/);
  assert.match(t2, /lenzuola e asciugamani/);
  assert.match(t2, /____/);
  assert.match(guestParagraph({}), /Il Sig\. ____/);
});

test('firma: solo JPEG valido e non troppo grande', () => {
  assert.equal(checkSignature(SIGN).ok, true);
  const info = jpegInfo(base64ToBytes(SIGN.split(',')[1]));
  assert.equal(info.width, 300);
  assert.equal(info.height, 100);
  assert.equal(checkSignature('data:image/png;base64,AAAA').ok, false);
  assert.equal(checkSignature('data:image/jpeg;base64,AAAA').ok, false);
  assert.equal(checkSignature(`data:image/jpeg;base64,${'A'.repeat(200000)}`).ok, false);
});

test('data di cancellazione: due anni dopo la partenza (anche il 29 febbraio)', () => {
  assert.equal(purgeDate('2027-07-17'), '2029-07-17');
  assert.equal(purgeDate('2028-02-29'), '2030-03-01');
});

/* ------------------------------ Operazioni ------------------------------ */

test('firma: salva il contratto, spunta il passaggio, calcola l’impronta', async () => {
  const { db, admin, b } = await setup();
  const r = await runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b) });
  assert.equal(r.ok, true);
  assert.equal(r.record.booking_id, b.id);
  assert.equal(r.record.hash.length, 64);
  assert.equal(r.record.purge_after, purgeDate(b.check_out));
  assert.equal(r.record.guest_sign, undefined, 'le firme non vanno nell’elenco generale');
  assert.equal(JSON.parse(r.booking.checkin_steps).contratto, 1);
  // L'impronta torna con i dati salvati.
  const row = await db.prepare('SELECT * FROM contracts WHERE id = ?').bind(r.record.id).first();
  assert.equal(await sha256Hex(hashInput(row)), row.hash);
  const text = contractText(JSON.parse(row.body));
  assert.match(text, /Anna Verdi/);
  assert.match(text, /Mario Rossi/);
  // Nello stato: solo i metadati.
  const st = await readState(db, admin);
  assert.equal(st.contracts.length, 1);
  assert.equal(st.contracts[0].body, undefined);
  // Nel registro: niente dati personali.
  const h = await readHistory(db, b.id);
  const signed = h.find((x) => x.entity === 'contract');
  assert.ok(signed);
  assert.doesNotMatch(JSON.stringify(signed), /Verdi|Milano|CA12345AB/);
});

test('firma: rifiuti (non diretta, dati mancanti, già firmato, senza conferma, firma non valida)', async () => {
  const { db, admin, b } = await setup();
  await expectOpError(runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b, { accepted: false }) }), 'validation');
  await expectOpError(runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b, { host_sign: 'x' }) }), 'validation', /locatore/);
  await expectOpError(runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b, { guest: { ...GUEST, doc_number: '' } }) }), 'validation');
  await runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b) });
  await expectOpError(runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b) }), 'state', /già un contratto/);
  const air = (await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking({ channel: 'airbnb', check_in: addDays(T, 30), check_out: addDays(T, 33) }) } })).record;
  await expectOpError(runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(air) }), 'validation', /dirette/);
  const ib = (await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: booking({ house_id: 'isola-bella', guests: 2 }) } })).record;
  await expectOpError(runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(ib) }), 'contract_info', /Impostazioni/);
});

test('firma ripetuta con lo stesso codice: non crea un secondo contratto', async () => {
  const { db, admin, b } = await setup();
  const body = { opId: op(), type: 'contract.sign', payload: signPayload(b) };
  await runOp(db, admin, body);
  const again = await runOp(db, admin, body);
  assert.equal(again.replay, true);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM contracts').first();
  assert.equal(n.n, 1);
});

test('lettura del contratto: amministratore sì, collaboratore solo se l’ha fatto firmare lui di recente', async () => {
  const { db, admin, collab, b } = await setup();
  const r = await runOp(db, collab, { opId: op(), type: 'contract.sign', payload: signPayload(b) });
  const c = await readContract(db, admin, r.record.id);
  assert.equal(c.guest.name, 'Anna Verdi');
  assert.ok(c.guest_sign.startsWith('data:image/jpeg'));
  assert.equal((await readContract(db, collab, r.record.id)).id, r.record.id);
  await db.prepare("UPDATE contracts SET signed_at = '2020-01-01T00:00:00Z'").run();
  await expectOpError(readContract(db, collab, r.record.id), 'forbidden');
  const other = await addUser(db, { email: 'altro@example.invalid', name: 'Altro', role: 'collaboratore' });
  await expectOpError(readContract(db, other, r.record.id), 'forbidden');
});

test('i dati personali del locatore non arrivano ai collaboratori', async () => {
  const { db, admin, collab, b } = await setup();
  const stA = await readState(db, admin);
  const stC = await readState(db, collab);
  const fb = (st) => st.houses.find((x) => x.id === 'faro-blu');
  assert.match(fb(stA).contract_info, /Mario Rossi/);
  assert.equal(fb(stC).contract_info, undefined);
  assert.equal(fb(stC).contract_ready, 1);
  assert.equal(stC.houses.find((x) => x.id === 'isola-bella').contract_ready, 0);
  // Il testo da firmare però lo può aprire anche il collaboratore che fa il check-in.
  const d = await contractDraft(db, b.id);
  assert.equal(d.ready, true);
  assert.ok(d.blocks.some((x) => x.t === 'guest'));
  // E nel registro della casa non finiscono i dati del locatore.
  const log = await db.prepare("SELECT changes FROM audit_log WHERE entity = 'house'").all();
  assert.doesNotMatch(JSON.stringify(log.results), /Mario Rossi|Lecce/);
});

test('eliminare un contratto: solo l’amministratore, contenuto svuotato subito, passaggio tolto', async () => {
  const { db, admin, collab, b } = await setup();
  const r = await runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b) });
  await expectOpError(runOp(db, collab, { opId: op(), type: 'contract.delete', payload: { id: r.record.id } }), 'forbidden');
  const del = await runOp(db, admin, { opId: op(), type: 'contract.delete', payload: { id: r.record.id } });
  assert.equal(del.record.deleted, 1);
  assert.equal(JSON.parse(del.booking.checkin_steps).contratto, 0);
  const row = await db.prepare('SELECT * FROM contracts WHERE id = ?').bind(r.record.id).first();
  assert.equal(row.guest_sign, '');
  assert.equal(row.body, '[]');
  assert.doesNotMatch(JSON.stringify(row), /Verdi|CA12345AB/);
  // Si può rifare.
  await runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b) });
});

test('cancellazione automatica dopo il periodo di conservazione', async () => {
  const { db, admin, b } = await setup();
  const r = await runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b) });
  assert.equal(await purgeContracts(db, T), 0);
  const before = (await db.prepare("SELECT value FROM meta WHERE key = 'rev'").first()).value;
  assert.equal(await purgeContracts(db, addDays(r.record.purge_after, 1)), 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM contracts').first()).n, 0);
  assert.equal((await db.prepare("SELECT value FROM meta WHERE key = 'rev'").first()).value, before + 1);
  const h = await readHistory(db, b.id);
  assert.ok(h.some((x) => x.action === 'purge'));
});

test('copia dei dati: contiene i contratti', async () => {
  const { db, admin, b } = await setup();
  await runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b) });
  const ex = await readExport(db);
  assert.equal(ex.contracts.length, 1);
});

/* ------------------------------ PDF ------------------------------ */

test('PDF: struttura valida, testo, firme e impronta', async () => {
  const { db, admin, b } = await setup();
  const r = await runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b) });
  const c = await readContract(db, admin, r.record.id);
  const bytes = buildPdf(c);
  const head = Buffer.from(bytes.slice(0, 8)).toString('latin1');
  assert.equal(head, '%PDF-1.4');
  const tail = Buffer.from(bytes.slice(-6)).toString('latin1');
  assert.match(tail, /%%EOF/);
  const s = Buffer.from(bytes).toString('latin1');
  assert.match(s, /\/Subtype \/Image/);
  assert.match(s, /\/DCTDecode/);
  assert.match(s, new RegExp(c.hash.slice(0, 16)));
  // Riferimenti incrociati: ogni oggetto all'indirizzo giusto.
  const xref = s.slice(s.lastIndexOf('xref'));
  const offsets = [...xref.matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
  offsets.forEach((off, i) => assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
});

/* ------------------------------ Inglese ------------------------------ */

test('contratto in inglese: stesse clausole, testi inglesi della casa, importi in inglese', () => {
  const house = { checkin_time: '14:00', checkout_time: '10:00' };
  const info = { ...LANDLORD, city: 'Gallipoli', address: 'Via X 1', description: 'piano terra', description_en: 'ground floor', cin: 'IT075031C200088528',
    quiet_hours: 'dalle 23 alle 8', quiet_hours_en: 'from 11 pm to 8 am', kwh_day: 30, kwh_price_cents: 40, advance_pct: 30 };
  const b = { check_in: '2027-07-10', check_out: '2027-07-17', guests: 4, total_cents: 123456, security_cents: 30000, linens: 1, towels: 0 };
  const it = buildContract({ house, info, booking: b, guest: GUEST, signedAt: '2027-07-10T13:05:00Z' });
  const en = buildContract({ house, info, booking: b, guest: GUEST, signedAt: '2027-07-10T13:05:00Z', lang: 'en' });
  // Stessa struttura: stessi tipi di blocco, articolo per articolo.
  assert.deepEqual(en.map((x) => x.t), it.map((x) => x.t));
  const text = contractText(en);
  assert.match(text, /TOURIST RENTAL AGREEMENT/);
  assert.match(text, /Ms\. Anna Verdi, born in Milano on 03\/02\/1990/);
  assert.match(text, /acting as usufructuary of the property/);
  assert.match(text, /ground floor/);
  assert.doesNotMatch(text, /piano terra/);
  assert.match(text, /from 11 pm to 8 am/);
  assert.match(text, /approximately 30% of the rent/);
  assert.match(text, /non-refundable/);
  assert.match(text, /late arrival or early departure/);
  assert.match(text, /Towels are not included/);
  assert.match(text, /tourist tax is not included/);
  assert.match(text, /security deposit of €300 /);
  assert.match(text, /charged at €0\.40 per additional kWh/);
  assert.match(text, /for 2 years after the end of the stay/);
  assert.match(text, /governed by Italian law/);
  assert.doesNotMatch(text, /1,234|123,456|Airbnb|gas/i);
  assert.match(guestParagraph({}, 'en'), /^Mr\. ____/);
});

test('firma in inglese: lingua salvata, nell’impronta e nel PDF; lingua sconosciuta rifiutata', async () => {
  const { db, admin, b } = await setup();
  await expectOpError(runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b, { lang: '__proto__' }) }), 'validation', /Lingua/);
  await expectOpError(contractDraft(db, b.id, 'de'), 'validation');
  const d = await contractDraft(db, b.id, 'en');
  assert.equal(d.blocks[0].text, 'TOURIST RENTAL AGREEMENT – SHORT-TERM LEASE');
  const r = await runOp(db, admin, { opId: op(), type: 'contract.sign', payload: signPayload(b, { lang: 'en' }) });
  assert.equal(r.record.lang, 'en');
  const row = await db.prepare('SELECT * FROM contracts WHERE id = ?').bind(r.record.id).first();
  assert.equal(await sha256Hex(hashInput(row)), row.hash);
  assert.notEqual(await sha256Hex(hashInput({ ...row, lang: 'it' })), row.hash);
  assert.match(contractText(JSON.parse(row.body)), /Tenant/);
  const c = await readContract(db, admin, r.record.id);
  const s = Buffer.from(buildPdf(c)).toString('latin1');
  assert.match(s, /THE LANDLORD/);
  assert.match(s, /Page 1 of/);
  assert.equal((await readState(db, admin)).contracts[0].lang, 'en');
});

test('grassetto come nel Word: dati del locatore, CIN, orari, cauzione; gli asterischi scritti a mano non rompono il testo', () => {
  const house = { checkin_time: '14:00', checkout_time: '10:00' };
  const info = { ...LANDLORD, city: 'Gallipoli', address: 'Via X 1', description: 'piano terra', cin: 'IT075031C200088528', quiet_hours: 'dalle 23 alle 8', kwh_day: 30, kwh_price_cents: 40 };
  const b = { check_in: '2027-07-10', check_out: '2027-07-17', guests: 4, security_cents: 30000, linens: 1, towels: 0 };
  for (const lang of ['it', 'en']) {
    const blocks = buildContract({ house, info, booking: b, guest: { ...GUEST, name: 'Anna **Verdi**' }, signedAt: '2027-07-10T13:05:00Z', lang });
    const raw = blocks.map((x) => x.text || '').join('\n');
    assert.match(raw, /\*\*Mario Rossi\*\*/);
    assert.match(raw, /\*\*(Codice Identificativo Nazionale|National Identification Code) \(CIN\): IT075031C200088528\*\*/);
    assert.match(raw, /\*\*[^*]*(silenzio|quiet hours)[^*]*\*\*/);
    assert.match(raw, /\*\*(300 €|€300)\*\*/);
    // Ogni grassetto si apre e si chiude nello stesso blocco.
    for (const x of blocks) if (x.text) assert.equal((x.text.match(/\*\*/g) || []).length % 2, 0, x.text);
  }
  assert.equal(checkGuest({ ...GUEST, name: 'Anna **Verdi**' }, T).value.name, 'Anna Verdi');
});
