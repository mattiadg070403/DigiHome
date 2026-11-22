import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp, OpError } from '../src/ops.js';
import '../src/guests.js';
import '../src/dms.js';
import { checkConnection, fetchReceipt, receiptJob, saveCredentials, searchPlaces, sendSchedine, romeDay } from '../src/questura.js';
import { buildDmsXml, dmsFile } from '../src/dms.js';
import { purgeGuests } from '../src/guests.js';
import { openJson, sealJson } from '../src/secrets.js';
import { esitoOf, parseDocTypes, parsePlaces, tag, tagAll } from '../src/alloggiati-ws.js';
import { readExport, readState } from '../src/state.js';
import { ITALY, ageOn, guestMissing, guestType, plainName, schedina, sendWindow } from '../public/shared/alloggiati.js';
import { addDays, todayRome } from '../public/shared/dates.js';

const T = todayRome();
const op = () => crypto.randomUUID();
const ENV = { CHIAVE_CREDENZIALI: 'segreto-di-prova-lungo-almeno-trentadue-caratteri-0123456789' };
const PWD = 'PasswordSegreta!42';

/* ------------------------------ Regole ------------------------------ */

test('nomi senza accenti e in maiuscolo, tipi di schedina, finestra di invio, età', () => {
  assert.equal(plainName('  Niccolò  D’Àngelo-Rossi '), "NICCOLO D'ANGELO-ROSSI");
  assert.equal(plainName('Müller Straße'), 'MULLER STRASSE');
  assert.equal(plainName('José 3°'), 'JOSE');
  assert.equal(guestType(0, 1, 'famiglia'), '16');
  assert.equal(guestType(0, 3, 'famiglia'), '17');
  assert.equal(guestType(2, 3, 'famiglia'), '19');
  assert.equal(guestType(0, 3, 'gruppo'), '18');
  assert.equal(guestType(1, 3, 'gruppo'), '20');
  assert.ok(sendWindow(T, T).ok);
  assert.ok(sendWindow(addDays(T, -1), T).ok);
  assert.equal(sendWindow(addDays(T, 1), T).reason, 'early');
  assert.equal(sendWindow(addDays(T, -2), T).reason, 'late');
  assert.equal(ageOn('2000-08-10', '2026-08-09'), 25);
  assert.equal(ageOn('2000-08-10', '2026-08-10'), 26);
});

const PLACES = {
  '403075031': { kind: 'C', province: 'LE' }, // comune di prova
  [ITALY]: { kind: 'S', province: null },
  '100000216': { kind: 'S', province: null }, // stato estero di prova
};
const place = (c) => PLACES[c] || null;
const capo = { last_name: 'Rossi', first_name: 'Mario', sex: 'M', birth_date: '1980-05-02', birth_place: '403075031', citizenship: ITALY,
  residence: '403075031', doc_type: 'IDENT', doc_number: 'ca 1234567', doc_place: '403075031' };

test('schedina: 168 caratteri nelle posizioni del manuale', () => {
  const row = schedina(capo, { type: '17', checkIn: '2026-08-01', checkOut: '2026-08-08', place });
  assert.equal(row.length, 168);
  assert.equal(row.slice(0, 2), '17');
  assert.equal(row.slice(2, 12), '01/08/2026');
  assert.equal(row.slice(12, 14), '07');
  assert.equal(row.slice(14, 64).trimEnd(), 'ROSSI');
  assert.equal(row.slice(64, 94).trimEnd(), 'MARIO');
  assert.equal(row[94], '1');
  assert.equal(row.slice(95, 105), '02/05/1980');
  assert.equal(row.slice(105, 114), '403075031');
  assert.equal(row.slice(114, 116), 'LE');
  assert.equal(row.slice(116, 125), ITALY);
  assert.equal(row.slice(125, 134), ITALY);
  assert.equal(row.slice(134, 139), 'IDENT');
  assert.equal(row.slice(139, 159).trimEnd(), 'CA1234567');
  assert.equal(row.slice(159, 168), '403075031');
  // Nato all'estero: comune e provincia vuoti, stato di nascita = lo stato.
  const foreign = schedina({ ...capo, birth_place: '100000216', sex: 'F' }, { type: '16', checkIn: '2026-08-01', checkOut: '2026-08-03', place });
  assert.equal(foreign.slice(105, 116), ' '.repeat(11));
  assert.equal(foreign.slice(116, 125), '100000216');
  assert.equal(foreign[94], '2');
  // Familiare: niente documento.
  const fam = schedina({ ...capo, doc_type: null, doc_number: null, doc_place: null }, { type: '19', checkIn: '2026-08-01', checkOut: '2026-08-08', place });
  assert.equal(fam.slice(134, 168), ' '.repeat(34));
  // Più di 30 notti: si dichiarano 30 (massimo del portale).
  assert.equal(schedina(capo, { type: '16', checkIn: '2026-06-01', checkOut: '2026-07-20', place }).slice(12, 14), '30');
  assert.throws(() => schedina({ ...capo, doc_number: null }, { type: '16', checkIn: '2026-08-01', checkOut: '2026-08-08', place }), /numero del documento/);
  assert.deepEqual(guestMissing({ last_name: 'A', first_name: 'B' }, false), ['sesso', 'data di nascita', 'luogo di nascita', 'cittadinanza', 'residenza']);
});

test('credenziali cifrate: si leggono solo con lo stesso segreto e per la stessa casa', async () => {
  const sealed = await sealJson(ENV, 'alloggiati:faro-blu', { utente: 'u', password: PWD });
  assert.ok(!sealed.includes(PWD));
  assert.deepEqual(await openJson(ENV, 'alloggiati:faro-blu', sealed), { utente: 'u', password: PWD });
  await assert.rejects(openJson(ENV, 'alloggiati:isola-bella', sealed));
  await assert.rejects(openJson({ CHIAVE_CREDENZIALI: `${ENV.CHIAVE_CREDENZIALI}x` }, 'alloggiati:faro-blu', sealed));
  await assert.rejects(sealJson({ CHIAVE_CREDENZIALI: 'corto' }, 'x', {}), /missing_secret/);
});

test('tabelle ufficiali: colonne riconosciute dall’intestazione, stati e comuni, luoghi non più validi', () => {
  const csv = 'Codice;Descrizione;Provincia;DataFineVal\r\n403075031;GALLIPOLI;LE;\r\n100000100;ITALIA;ES;\r\n401001001;VECCHIO COMUNE;TO;31/12/1990\r\nxx;bad;;\r\n';
  const p = parsePlaces(csv);
  assert.deepEqual(p.map((x) => [x.code, x.kind, x.province, x.active]), [['403075031', 'C', 'LE', 1], ['100000100', 'S', null, 1], ['401001001', 'C', 'TO', 0]]);
  assert.deepEqual(parseDocTypes('Codice;Descrizione\nIDENT;CARTA DI IDENTITA\nPASOR;PASSAPORTO ORDINARIO\n'), [
    { code: 'IDENT', name: 'CARTA DI IDENTITA' }, { code: 'PASOR', name: 'PASSAPORTO ORDINARIO' }]);
  const xml = '<soap:Envelope><soap:Body><TestResponse xmlns="AlloggiatiService"><TestResult><esito>false</esito><ErroreCod>12</ErroreCod><ErroreDes>SCHEDINA_CAMPO_NON_CORRETTO</ErroreDes><ErroreDettaglio>Data nascita &amp; altro</ErroreDettaglio></TestResult></TestResponse></soap:Body></soap:Envelope>';
  assert.deepEqual(esitoOf(xml), { ok: false, code: '12', desc: 'SCHEDINA_CAMPO_NON_CORRETTO', detail: 'Data nascita & altro' });
  assert.equal(tag('<a:Token>x</a:Token>', 'token'), 'x');
  assert.equal(tagAll('<x><s>1</s><s>2</s></x>', 's').length, 2);
});

/* ------------------------------ Portale finto ------------------------------ */

function fakePortal({ rejectTest = false, failAuth = false, pdf = true } = {}) {
  const calls = [];
  const places = ['Codice;Descrizione;Provincia;DataFineVal', '403075031;GALLIPOLI;LE;', '403075035;LECCE;LE;', `${ITALY};ITALIA;ES;`, '100000216;GERMANIA;ES;'];
  for (let i = 0; i < 120; i++) places.push(`4010${String(i).padStart(5, '0')};COMUNE ${i};TO;`);
  const wrap = (m, inner) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${m}Response xmlns="AlloggiatiService">${inner}</${m}Response></soap:Body></soap:Envelope>`;
  const ok = '<esito>true</esito><ErroreCod /><ErroreDes /><ErroreDettaglio />';
  const fetchImpl = async (url, init) => {
    const method = /AlloggiatiService\/(\w+)/.exec(init.headers.SOAPAction)[1];
    calls.push({ method, body: init.body });
    assert.equal(url, 'https://alloggiatiweb.poliziadistato.it/service/service.asmx');
    if (method === 'GenerateToken') {
      if (failAuth) return new Response(wrap(method, '<GenerateTokenResult /><result><esito>false</esito><ErroreCod>100</ErroreCod><ErroreDes>Utente o password errati</ErroreDes></result>'));
      return new Response(wrap(method, `<GenerateTokenResult><issued>x</issued><expires>y</expires><token>TOKEN123</token></GenerateTokenResult><result>${ok}</result>`));
    }
    if (method === 'Authentication_Test') return new Response(wrap(method, `<Authentication_TestResult>${ok}</Authentication_TestResult>`));
    if (method === 'Tabella') {
      const tipo = /<all:tipo>(\w+)</.exec(init.body)[1];
      const csv = tipo === 'Luoghi' ? places.join('\r\n') : 'Codice;Descrizione\r\nIDENT;CARTA DI IDENTITA\r\nPASOR;PASSAPORTO ORDINARIO\r\nPATEN;PATENTE DI GUIDA';
      return new Response(wrap(method, `<TabellaResult>${ok}</TabellaResult><CSV>${csv}</CSV>`));
    }
    if (method === 'Test' || method === 'Send') {
      const n = (init.body.match(/<all:string>/g) || []).length;
      const bad = method === 'Test' && rejectTest;
      const det = Array.from({ length: n }, (_, i) => (bad && i === 1
        ? '<EsitoOperazioneServizio><esito>false</esito><ErroreCod>12</ErroreCod><ErroreDes>SCHEDINA_CAMPO_NON_CORRETTO</ErroreDes><ErroreDettaglio>Data di nascita</ErroreDettaglio></EsitoOperazioneServizio>'
        : `<EsitoOperazioneServizio>${ok}</EsitoOperazioneServizio>`)).join('');
      return new Response(wrap(method, `<${method}Result>${bad ? '<esito>false</esito>' : ok}</${method}Result><result><SchedineValide>${bad ? n - 1 : n}</SchedineValide><Dettaglio>${det}</Dettaglio></result>`));
    }
    if (method === 'Ricevuta') {
      if (!pdf) return new Response(wrap(method, `<RicevutaResult><esito>false</esito><ErroreDes>Nessuna ricevuta</ErroreDes></RicevutaResult>`));
      return new Response(wrap(method, `<RicevutaResult>${ok}</RicevutaResult><PDF>${Buffer.from('%PDF-1.4 ricevuta di prova').toString('base64')}</PDF>`));
    }
    return new Response('?', { status: 500 });
  };
  return { fetchImpl, calls };
}

async function setup({ guests = 3, checkIn = T, channel = 'airbnb' } = {}) {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', name: 'Mattia', role: 'admin' });
  const collab = await addUser(db, { email: 'collab@example.invalid', name: 'Rosa', role: 'collaboratore' });
  const b = (await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: {
    house_id: 'faro-blu', channel, guest_name: 'Famiglia Rossi', phone: '+39 000 000', guests,
    check_in: checkIn, check_out: addDays(checkIn, 7), total_cents: 100000, deposit_cents: 0, security_cents: 0,
  } } })).record;
  return { db, admin, collab, b };
}

async function addGuests(db, user, b, list) {
  let res;
  for (const g of list) res = await runOp(db, user, { opId: op(), type: 'guest.save', payload: { bookingId: b.id, id: op(), guest: g } });
  return res;
}

const famiglia = [capo,
  { ...capo, first_name: 'Anna', sex: 'F', birth_date: '1982-03-04', doc_type: null, doc_number: null, doc_place: null },
  { ...capo, first_name: 'Luca', birth_date: '2015-07-01', birth_place: '100000216', citizenship: '100000216', residence: '100000216', doc_type: null, doc_number: null, doc_place: null }];

test('credenziali: solo l’amministratore, mai nello stato né nella copia dei dati; prova e tabelle', async () => {
  const { db, admin, collab } = await setup();
  const portal = fakePortal();
  await assert.rejects(saveCredentials(db, ENV, collab, { houseId: 'faro-blu', utente: 'U', password: PWD, wskey: 'K' }), /amministratore/);
  await assert.rejects(saveCredentials(db, {}, admin, { houseId: 'faro-blu', utente: 'U', password: PWD, wskey: 'K' }), /chiave segreta/);
  const r = await saveCredentials(db, ENV, admin, { houseId: 'faro-blu', utente: 'UTENTE01', password: PWD, wskey: 'WSKEY-SEGRETA' }, { fetchImpl: portal.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.tables.places, 124);
  assert.equal(r.status.configured, true);
  assert.equal(r.status.user_hint, 'UTE…');
  const state = JSON.stringify(await readState(db, admin)) + JSON.stringify(await readState(db, collab)) + JSON.stringify(await readExport(db));
  for (const s of [PWD, 'WSKEY-SEGRETA', 'UTENTE01']) assert.ok(!state.includes(s), s);
  const row = await db.prepare('SELECT alloggiati FROM house_secrets').first();
  assert.ok(!row.alloggiati.includes(PWD));
  assert.deepEqual((await searchPlaces(db, 'gall', 'C')).map((x) => x.name), ['GALLIPOLI']);
  assert.deepEqual((await searchPlaces(db, 'ger', 'S')).map((x) => x.code), ['100000216']);
  // Accesso rifiutato: errore leggibile e salvato nello stato della casa.
  const bad = await checkConnection(db, ENV, admin, { houseId: 'faro-blu' }, { fetchImpl: fakePortal({ failAuth: true }).fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Utente o password errati/);
  // Rimozione.
  await saveCredentials(db, ENV, admin, { houseId: 'faro-blu', remove: true });
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM house_secrets').first('n'), 0);
});

test('ospiti: dati salvati, conteggi sulla prenotazione, capogruppo, dati personali fuori dallo stato e dalla coda', async () => {
  const { db, admin, collab, b } = await setup();
  const res = await addGuests(db, collab, b, famiglia);
  assert.equal(res.guests.length, 3);
  assert.equal(res.record.guests_entered, 3);
  assert.equal(res.record.guests_done, 3);
  assert.equal(res.guests[0].doc_number, 'CA1234567');
  const st = JSON.stringify(await readState(db, admin));
  assert.ok(!st.includes('CA1234567') && !st.includes('Anna'));
  const log = JSON.stringify((await db.prepare('SELECT changes FROM audit_log WHERE entity = ?').bind('guest').all()).results);
  assert.ok(!log.includes('Mario') && !log.includes('1234567'));
  // Il nuovo capo deve avere il documento: senza, risulta incompleto.
  const lead = await runOp(db, admin, { opId: op(), type: 'guest.leader', payload: { id: res.guests[1].id } });
  assert.equal(lead.guests[0].first_name, 'Anna');
  assert.equal(lead.record.guests_done, 2);
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'guest.save', payload: { bookingId: b.id, id: op(), guest: { ...capo, birth_place: '12' } } }), OpError);
  await assert.rejects(runOp(db, admin, { opId: op(), type: 'guest.save', payload: { bookingId: b.id, id: op(), guest: { ...capo, birth_date: addDays(T, 1) } } }), /nascita/);
  const del = await runOp(db, admin, { opId: op(), type: 'guest.delete', payload: { id: lead.guests[2].id } });
  assert.deepEqual(del.guests.map((g) => g.position), [0, 1]);
});

test('invio: controllo del portale, poi invio; passaggio spuntato; niente doppio invio', async () => {
  const { db, admin, collab, b } = await setup();
  const portal = fakePortal();
  await saveCredentials(db, ENV, admin, { houseId: 'faro-blu', utente: 'U', password: PWD, wskey: 'K' }, { fetchImpl: portal.fetchImpl });
  // Dati mancanti → non parte niente.
  await assert.rejects(sendSchedine(db, ENV, collab, { bookingId: b.id }, { fetchImpl: portal.fetchImpl }), /dati degli ospiti/);
  await addGuests(db, collab, b, famiglia.slice(0, 2));
  await assert.rejects(sendSchedine(db, ENV, collab, { bookingId: b.id }, { fetchImpl: portal.fetchImpl }), /Ospiti inseriti: 2/);
  await addGuests(db, collab, b, famiglia.slice(2));
  portal.calls.length = 0;
  const r = await sendSchedine(db, ENV, collab, { bookingId: b.id }, { fetchImpl: portal.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.deepEqual(portal.calls.map((c) => c.method), ['GenerateToken', 'Test', 'Send']);
  const sent = portal.calls[2].body;
  assert.equal((sent.match(/<all:string>/g) || []).length, 3);
  assert.ok(sent.indexOf('>17') < sent.indexOf('>19'));
  assert.ok(r.record.alloggiati_at);
  assert.equal(JSON.parse(r.record.checkin_steps).alloggiati, 1);
  await assert.rejects(sendSchedine(db, ENV, collab, { bookingId: b.id }, { fetchImpl: portal.fetchImpl }), /già state inviate/);
});

test('invio: se il controllo trova un errore non si invia niente; fuori finestra rifiutato', async () => {
  const { db, admin, b } = await setup();
  const portal = fakePortal({ rejectTest: true });
  await saveCredentials(db, ENV, admin, { houseId: 'faro-blu', utente: 'U', password: PWD, wskey: 'K' }, { fetchImpl: fakePortal().fetchImpl });
  await addGuests(db, admin, b, famiglia);
  const r = await sendSchedine(db, ENV, admin, { bookingId: b.id }, { fetchImpl: portal.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'test');
  assert.match(r.message, /ANNA ROSSI|Anna Rossi/);
  assert.ok(!portal.calls.some((c) => c.method === 'Send'));
  assert.equal(r.record.alloggiati_at, null);
  assert.match(r.record.alloggiati_error, /Controllo del portale/);
  // Arrivo tra due giorni: non si può ancora inviare.
  const s2 = await setup({ checkIn: addDays(T, 2) });
  await saveCredentials(s2.db, ENV, s2.admin, { houseId: 'faro-blu', utente: 'U', password: PWD, wskey: 'K' }, { fetchImpl: fakePortal().fetchImpl });
  await assert.rejects(sendSchedine(s2.db, ENV, s2.admin, { bookingId: s2.b.id }, { fetchImpl: fakePortal().fetchImpl }), /dal giorno dell’arrivo/);
});

test('ricevute: scaricate il giorno dopo, conservate 5 anni, dati dei documenti cancellati', async () => {
  const { db, admin, b } = await setup({ checkIn: addDays(T, -1) });
  const portal = fakePortal();
  await saveCredentials(db, ENV, admin, { houseId: 'faro-blu', utente: 'U', password: PWD, wskey: 'K' }, { fetchImpl: portal.fetchImpl });
  await addGuests(db, admin, b, famiglia);
  const r = await sendSchedine(db, ENV, admin, { bookingId: b.id }, { fetchImpl: portal.fetchImpl });
  assert.equal(r.ok, true);
  // Oggi la ricevuta non c'è ancora (il portale la dà dal giorno dopo).
  const day = romeDay(r.record.alloggiati_at);
  let job = await receiptJob(db, ENV, { fetchImpl: portal.fetchImpl, today: day });
  assert.equal(job.fetched, 0);
  job = await receiptJob(db, ENV, { fetchImpl: portal.fetchImpl, today: addDays(day, 1) });
  assert.equal(job.fetched, 1);
  const rec = await db.prepare('SELECT * FROM alloggiati_receipts').first();
  assert.equal(rec.date, day);
  assert.equal(rec.purge_after, `${Number(day.slice(0, 4)) + 5}${day.slice(4)}`);
  const g = await db.prepare('SELECT doc_number, doc_purged_at, last_name FROM guests WHERE position = 0').first();
  assert.equal(g.doc_number, null);
  assert.ok(g.doc_purged_at);
  assert.equal(g.last_name, 'Rossi');
  // Già scaricata: non si riscarica.
  assert.equal((await fetchReceipt(db, ENV, 'faro-blu', day, { fetchImpl: portal.fetchImpl })).existing, true);
  // Dopo 5 anni si cancella da sola.
  job = await receiptJob(db, ENV, { fetchImpl: portal.fetchImpl, today: addDays(day, 5 * 366) });
  assert.equal(job.purged, 1);
  // Ospiti: cancellati un anno dopo la partenza.
  assert.equal(await purgeGuests(db, addDays(b.check_out, 366)), 3);
});

test('DMS: un movimento per ogni giorno, arrivi con componenti, partenza del capo, niente nomi', async () => {
  const { db, admin, b } = await setup({ checkIn: addDays(T, -3) });
  const portal = fakePortal();
  await saveCredentials(db, ENV, admin, { houseId: 'faro-blu', utente: 'U', password: PWD, wskey: 'K' }, { fetchImpl: portal.fetchImpl });
  await assert.rejects(dmsFile(db, 'faro-blu', addDays(T, -4), T), /camere e posti letto/);
  await runOp(db, admin, { opId: op(), type: 'house.dms', payload: { houseId: 'faro-blu', rooms: 3, beds: 8 } });
  await assert.rejects(dmsFile(db, 'faro-blu', addDays(T, -4), T), /ospiti inseriti 0 su 3/);
  const res = await addGuests(db, admin, b, famiglia);
  const { xml } = await dmsFile(db, 'faro-blu', addDays(T, -4), addDays(T, 5));
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  const days = [...xml.matchAll(/<movimento type="(\w+)" data="([\d-]+)">/g)].map((m) => [m[1], m[2]]);
  assert.equal(days.length, 10);
  assert.deepEqual(days[0], ['NM', addDays(T, -4)]);
  assert.deepEqual(days[1], ['MP', addDays(T, -3)]);
  assert.deepEqual(days[8], ['MP', addDays(T, 4)]); // partenza dopo 7 notti
  assert.match(xml, new RegExp(`<arrivo><codiceclientesr>${res.guests[0].code}</codiceclientesr><sesso>M</sesso><cittadinanza>${ITALY}</cittadinanza><comuneresidenza>403075031</comuneresidenza>`));
  assert.match(xml, /<tipologiaalloggiato>17<\/tipologiaalloggiato><eta>\d+<\/eta><componenti><componente>/);
  assert.match(xml, /<paeseresidenza>100000216<\/paeseresidenza>/);
  assert.match(xml, new RegExp(`<partenze><codiceclientesr>${res.guests[0].code}</codiceclientesr></partenze>`));
  assert.match(xml, /<camereoccupate>3<\/camereoccupate>/);
  assert.match(xml, /<camereoccupate>0<\/camereoccupate>/);
  assert.ok(!/Rossi|ROSSI|Mario|IDENT|1234567/.test(xml));
  // Primo file che inizia con la casa occupata: rifiutato.
  await assert.rejects(dmsFile(db, 'faro-blu', addDays(T, -1), T), /casa è vuota/);
  // Dopo aver segnato l'ultimo giorno caricato, va bene.
  await runOp(db, admin, { opId: op(), type: 'house.dms', payload: { houseId: 'faro-blu', sentOnly: true, sent_until: addDays(T, -2) } });
  // L'arrivo del periodo ha il passaggio "DMS Puglia" spuntato da solo.
  assert.equal(JSON.parse((await db.prepare('SELECT checkin_steps FROM bookings WHERE id = ?').bind(b.id).first()).checkin_steps).dms, 1);
  assert.ok((await dmsFile(db, 'faro-blu', addDays(T, -1), T)).xml);
  assert.throws(() => buildDmsXml({ house: { id: 'x', dms_settings: '{"rooms":1,"beds":2}' }, bookings: [], guestsByBooking: new Map(), from: T, to: addDays(T, 200) }), /92 giorni/);
});
