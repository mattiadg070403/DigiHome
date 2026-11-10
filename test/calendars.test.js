import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp, OpError } from '../src/ops.js';
import { readState, readHistory } from '../src/state.js';
import { parseIcs, airbnbInfo } from '../src/ical.js';
import { syncAll, applyEvents } from '../src/calendars.js';
import { checkCalendarUrl } from '../public/shared/calendar.js';
import { addDays, todayRome } from '../public/shared/dates.js';

const T = todayRome();
const op = () => crypto.randomUUID();
const ymd = (iso) => iso.replaceAll('-', '');

const AIRBNB_URL = 'https://www.airbnb.it/calendar/ical/123456.ics?s=segreto';
const BOOKING_URL = 'https://ical.booking.com/v1/export?t=segreto-booking';

function ev({ uid, start, end, summary = 'Reserved', description = '' }) {
  return ['BEGIN:VEVENT', `DTEND;VALUE=DATE:${ymd(end)}`, `DTSTART;VALUE=DATE:${ymd(start)}`, `UID:${uid}`,
    ...(description ? [`DESCRIPTION:${description}`] : []), `SUMMARY:${summary}`, 'END:VEVENT'].join('\r\n');
}
function ics(...events) {
  return ['BEGIN:VCALENDAR', 'PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
}
function fetcherFor(map) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const body = map[url];
    if (body instanceof Error) throw body;
    if (typeof body === 'number') return new Response('no', { status: body });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/calendar' } });
  };
  f.calls = calls;
  return f;
}

async function setup() {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', role: 'admin' });
  const collab = await addUser(db, { email: 'collab@example.invalid', name: 'Collab', role: 'collaboratore' });
  const cal = async (id) => db.prepare('SELECT * FROM calendars WHERE id = ?').bind(id).first();
  const connect = async (id, url) => {
    const c = await cal(id);
    return runOp(db, admin, { opId: op(), type: 'calendar.update', payload: { id, version: c.version, import_url: url } });
  };
  const bookings = async () => (await db.prepare('SELECT * FROM bookings ORDER BY check_in').all()).results;
  return { db, admin, collab, cal, connect, bookings };
}

const DESC = 'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCD1234\\nPhone Number (Last 4 Digits): 1234';

test('lettura iCal: righe spezzate, date, testi, blocchi e link della prenotazione', () => {
  const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260710\r\nDTEND;VALUE=DATE:20260714\r\nUID:abc\r\n @airbnb.com\r\nSUMMARY:Reserved\r\nDESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMXY12345Z\\nPhone Number (Last 4 Digits): 9999\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260801\r\nDTEND;VALUE=DATE:20260731\r\nUID:sbagliato\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const r = parseIcs(text);
  assert.ok(r.ok);
  assert.equal(r.events.length, 1, 'l’evento con fine prima dell’inizio si scarta');
  assert.deepEqual({ uid: r.events[0].uid, start: r.events[0].start, end: r.events[0].end }, { uid: 'abc@airbnb.com', start: '2026-07-10', end: '2026-07-14' });
  assert.deepEqual(airbnbInfo(r.events[0]), { code: 'HMXY12345Z', url: 'https://www.airbnb.com/hosting/reservations/details/HMXY12345Z' });
  assert.equal(parseIcs('<html>login</html>').ok, false);
  assert.equal(parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260231\nDTEND:20260301\nUID:x\nEND:VEVENT\nEND:VCALENDAR').events.length, 0, 'data impossibile');
});

test('link dei calendari: solo https e solo dal sito giusto', () => {
  assert.equal(checkCalendarUrl('airbnb', AIRBNB_URL).ok, true);
  assert.equal(checkCalendarUrl('airbnb', 'https://www.airbnb.com/calendar/ical/1.ics?s=x').ok, true);
  assert.equal(checkCalendarUrl('booking', BOOKING_URL).ok, true);
  assert.equal(checkCalendarUrl('booking', 'https://admin.booking.com/hotel/hoteladmin/ical.html?t=x').ok, true);
  assert.equal(checkCalendarUrl('airbnb', 'http://www.airbnb.it/calendar/ical/1.ics').ok, false);
  assert.equal(checkCalendarUrl('airbnb', BOOKING_URL).ok, false);
  assert.equal(checkCalendarUrl('booking', 'https://booking.com.truffa.example/x').ok, false);
  assert.equal(checkCalendarUrl('airbnb', 'https://airbnb.it.example.com/x').ok, false);
  assert.equal(checkCalendarUrl('airbnb', 'https://user:pw@www.airbnb.it/x').ok, false);
  assert.equal(checkCalendarUrl('airbnb', 'non è un link').ok, false);
  assert.deepEqual(checkCalendarUrl('airbnb', '  '), { ok: true, url: null });
});

test('collegare un calendario: solo l’amministratore, e il link non esce mai dal server', async () => {
  const { db, admin, collab, connect } = await setup();
  await assert.rejects(runOp(db, collab, { opId: op(), type: 'calendar.update', payload: { id: 'faro-blu:airbnb', version: 1, import_url: AIRBNB_URL } }),
    (e) => e instanceof OpError && e.code === 'forbidden');
  await assert.rejects(connect('faro-blu:airbnb', 'https://example.com/x.ics'), (e) => e.code === 'validation');
  const r = await connect('faro-blu:airbnb', AIRBNB_URL);
  assert.equal(r.record.connected, 1);
  assert.equal(r.record.url_hint, 'www.airbnb.it/…');
  assert.ok(!JSON.stringify(r).includes('segreto'));
  const stA = await readState(db, admin);
  assert.ok(!JSON.stringify(stA).includes('segreto'), 'lo stato dell’amministratore non contiene il link');
  assert.equal(stA.calendars.find((c) => c.id === 'faro-blu:airbnb').connected, 1);
  const stC = await readState(db, collab);
  assert.deepEqual(stC.calendars, []);
  const log = (await db.prepare("SELECT changes FROM audit_log WHERE entity = 'calendar'").all()).results;
  assert.ok(!JSON.stringify(log).includes('segreto'), 'il registro non contiene il link');
});

test('Airbnb: crea le prenotazioni nuove, ignora blocchi e passato, non duplica', async () => {
  const { db, admin, connect, bookings } = await setup();
  await connect('faro-blu:airbnb', AIRBNB_URL);
  const feed = ics(
    ev({ uid: 'a1@airbnb.com', start: addDays(T, 10), end: addDays(T, 14), description: DESC }),
    ev({ uid: 'blk@airbnb.com', start: addDays(T, 20), end: addDays(T, 25), summary: 'Airbnb (Not available)' }),
    ev({ uid: 'old@airbnb.com', start: addDays(T, -10), end: addDays(T, -5) }),
  );
  const fetcher = fetcherFor({ [AIRBNB_URL]: feed });
  const [r] = await syncAll(db, { fetcher });
  assert.ok(r.ok, r.error);
  assert.equal(r.created, 1);
  assert.equal(r.count, 1);
  let list = await bookings();
  assert.equal(list.length, 1);
  const b = list[0];
  assert.equal(b.channel, 'airbnb');
  assert.equal(b.guest_name, 'Ospite Airbnb (HMABCD1234)');
  assert.equal(b.needs_details, 1);
  assert.equal(b.ext_url, 'https://www.airbnb.com/hosting/reservations/details/HMABCD1234');
  assert.ok(!JSON.stringify(b).includes('1234\\n'), 'le ultime cifre del telefono non si salvano');
  // Seconda volta: nessun cambiamento, nessuna nuova riga nel registro
  const logBefore = (await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first()).n;
  const [r2] = await syncAll(db, { fetcher });
  assert.equal(r2.created + r2.updated + r2.cancelled, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first()).n, logBefore);
  list = await bookings();
  assert.equal(list.length, 1);
  const st = await readState(db, admin);
  const c = st.calendars.find((x) => x.id === 'faro-blu:airbnb');
  assert.equal(c.last_error, null);
  assert.equal(c.last_count, 1);
  assert.ok(c.last_ok_at);
  const hist = await readHistory(db, b.id);
  assert.equal(hist.at(-1).who, 'Calendario automatico');
});

test('dati completati dal modulo: l’avviso sparisce, le date continuano ad arrivare da Airbnb', async () => {
  const { db, admin, connect, bookings } = await setup();
  await connect('isola-bella:airbnb', AIRBNB_URL);
  const f1 = fetcherFor({ [AIRBNB_URL]: ics(ev({ uid: 'a1', start: addDays(T, 10), end: addDays(T, 14) })) });
  await syncAll(db, { fetcher: f1 });
  let [b] = await bookings();
  const r = await runOp(db, admin, { opId: op(), type: 'booking.update', payload: { id: b.id, version: b.version, changes: { guest_name: 'Anna Verdi', guests: 3 } } });
  assert.equal(r.record.needs_details, 0);
  // Su Airbnb l'ospite allunga il soggiorno
  const f2 = fetcherFor({ [AIRBNB_URL]: ics(ev({ uid: 'a1', start: addDays(T, 10), end: addDays(T, 16) })) });
  const [s] = await syncAll(db, { fetcher: f2 });
  assert.equal(s.updated, 1);
  [b] = await bookings();
  assert.equal(b.check_out, addDays(T, 16));
  assert.equal(b.guest_name, 'Anna Verdi', 'i dati inseriti a mano restano');
  assert.equal(b.guests, 3);
});

test('cancellata su Airbnb: si cancella da sola; se ricompare torna; calendario vuoto non cancella', async () => {
  const { db, admin, connect, bookings } = await setup();
  await connect('isola-bella:airbnb', AIRBNB_URL);
  const blk = ev({ uid: 'blk', start: addDays(T, 200), end: addDays(T, 210), summary: 'Airbnb (Not available)' });
  await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: ics(ev({ uid: 'a1', start: addDays(T, 10), end: addDays(T, 14) }), blk) }) });
  // Sparita (il calendario ha altri eventi): cancellata in automatico
  const [r] = await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: ics(blk) }) });
  assert.equal(r.cancelled, 1);
  let [b] = await bookings();
  assert.equal(b.stage, 'cancellata');
  assert.equal(b.ext_gone, 1);
  // Ricompare: torna confermata
  await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: ics(ev({ uid: 'a1', start: addDays(T, 10), end: addDays(T, 14) }), blk) }) });
  [b] = await bookings();
  assert.equal(b.stage, 'confermata');
  assert.equal(b.ext_gone, 0);
  // Calendario completamente vuoto: non si cancella, si segnala
  const [r3] = await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: ics() }) });
  assert.equal(r3.cancelled, 0);
  assert.equal(r3.flagged, 1);
  [b] = await bookings();
  assert.equal(b.stage, 'confermata');
  assert.equal(b.ext_gone, 1);
  // "È ancora valida"
  const ack = await runOp(db, admin, { opId: op(), type: 'booking.ext_ack', payload: { id: b.id, version: b.version } });
  assert.equal(ack.record.ext_gone, 0);
  assert.equal(ack.record.ext_uid, null, 'staccata dal calendario');
  // Al prossimo aggiornamento non viene ricancellata
  const [r4] = await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: ics(blk) }) });
  assert.equal(r4.cancelled, 0);
  [b] = await bookings();
  assert.equal(b.stage, 'confermata');
});

test('cancellata in automatico e poi ripristinata a mano: resta, non viene ricancellata', async () => {
  const { db, admin, connect, bookings } = await setup();
  await connect('isola-bella:airbnb', AIRBNB_URL);
  const blk = ev({ uid: 'blk', start: addDays(T, 200), end: addDays(T, 210), summary: 'Airbnb (Not available)' });
  await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: ics(ev({ uid: 'a1', start: addDays(T, 10), end: addDays(T, 14) }), blk) }) });
  const only = fetcherFor({ [AIRBNB_URL]: ics(blk) });
  await syncAll(db, { fetcher: only });
  let [b] = await bookings();
  assert.equal(b.stage, 'cancellata');
  await runOp(db, admin, { opId: op(), type: 'booking.restore', payload: { id: b.id, version: b.version } });
  await syncAll(db, { fetcher: only });
  [b] = await bookings();
  assert.equal(b.stage, 'confermata');
  assert.equal(b.ext_uid, null);
  assert.equal(b.ext_gone, 0);
});

test('cancellata a mano da Mattia (es. "non è una prenotazione"): il calendario non la ricrea', async () => {
  const { db, admin, connect, bookings } = await setup();
  await connect('faro-blu:booking', BOOKING_URL);
  const feed = ics(ev({ uid: 'b1@booking.com', start: addDays(T, 30), end: addDays(T, 33), summary: 'CLOSED - Not available' }));
  const fetcher = fetcherFor({ [BOOKING_URL]: feed });
  const [r] = await syncAll(db, { fetcher });
  assert.equal(r.created, 1, 'su Booking anche "CLOSED - Not available" è una prenotazione');
  let [b] = await bookings();
  assert.equal(b.guest_name, 'Ospite Booking');
  await runOp(db, admin, { opId: op(), type: 'booking.cancel', payload: { id: b.id, version: b.version } });
  await syncAll(db, { fetcher });
  const list = await bookings();
  assert.equal(list.length, 1);
  assert.equal(list[0].stage, 'cancellata');
});

test('Booking: le date che sono la copia di prenotazioni Airbnb o dirette si ignorano', async () => {
  const { db, admin, connect, bookings } = await setup();
  await connect('faro-blu:airbnb', AIRBNB_URL);
  await connect('faro-blu:booking', BOOKING_URL);
  await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: {
    house_id: 'faro-blu', channel: 'diretto', guest_name: 'Diretto', guests: 2, check_in: addDays(T, 40), check_out: addDays(T, 44), total_cents: 50000 } } });
  const fetcher = fetcherFor({
    [AIRBNB_URL]: ics(ev({ uid: 'a1', start: addDays(T, 10), end: addDays(T, 14) })),
    [BOOKING_URL]: ics(
      ev({ uid: 'copia-airbnb', start: addDays(T, 10), end: addDays(T, 14), summary: 'CLOSED - Not available' }),
      ev({ uid: 'copia-diretta', start: addDays(T, 41), end: addDays(T, 43), summary: 'CLOSED - Not available' }),
      ev({ uid: 'vera', start: addDays(T, 20), end: addDays(T, 23), summary: 'CLOSED - Not available' }),
    ),
  });
  const res = await syncAll(db, { fetcher });
  assert.deepEqual(fetcher.calls, [AIRBNB_URL, BOOKING_URL], 'prima Airbnb, poi Booking');
  const list = await bookings();
  assert.deepEqual(list.map((b) => b.channel), ['airbnb', 'booking', 'diretto']);
  assert.equal(res[1].count, 1);
});

test('prenotazione già inserita a mano: si collega invece di duplicarla', async () => {
  const { db, admin, connect, bookings } = await setup();
  await connect('faro-blu:airbnb', AIRBNB_URL);
  await runOp(db, admin, { opId: op(), type: 'booking.create', payload: { booking: {
    house_id: 'faro-blu', channel: 'airbnb', guest_name: 'Mario Rossi', guests: 4, check_in: addDays(T, 10), check_out: addDays(T, 14) } } });
  const [r] = await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: ics(ev({ uid: 'a1', start: addDays(T, 10), end: addDays(T, 14), description: DESC })) }) });
  assert.equal(r.created, 0);
  assert.equal(r.updated, 1);
  const list = await bookings();
  assert.equal(list.length, 1);
  assert.equal(list[0].guest_name, 'Mario Rossi');
  assert.equal(list[0].ext_uid, 'a1');
  assert.equal(list[0].needs_details, 0);
});

test('codice cambiato con le date (Airbnb): si sposta la stessa prenotazione, senza perdere i dati', async () => {
  const { db, admin, connect, bookings } = await setup();
  await connect('faro-blu:airbnb', AIRBNB_URL);
  const blk = ev({ uid: 'blk', start: addDays(T, 300), end: addDays(T, 301), summary: 'Airbnb (Not available)' });
  await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: ics(ev({ uid: 'a1', start: addDays(T, 10), end: addDays(T, 14) }), blk) }) });
  let [b] = await bookings();
  await runOp(db, admin, { opId: op(), type: 'booking.update', payload: { id: b.id, version: b.version, changes: { guest_name: 'Luca Neri' } } });
  await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: ics(ev({ uid: 'a2', start: addDays(T, 11), end: addDays(T, 15) }), blk) }) });
  const list = await bookings();
  assert.equal(list.length, 1);
  [b] = list;
  assert.equal(b.guest_name, 'Luca Neri');
  assert.equal(b.check_in, addDays(T, 11));
  assert.equal(b.stage, 'confermata');
});

test('errori: link non più valido, risposta non calendario, sito irraggiungibile', async () => {
  const { db, admin, connect, bookings } = await setup();
  await connect('faro-blu:airbnb', AIRBNB_URL);
  let [r] = await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: 404 }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /non funziona più/);
  [r] = await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: '<html>accedi</html>' }) });
  assert.match(r.error, /non restituisce un calendario/);
  [r] = await syncAll(db, { fetcher: fetcherFor({ [AIRBNB_URL]: new TypeError('network') }) });
  assert.match(r.error, /non risponde/);
  assert.equal((await bookings()).length, 0);
  const st = await readState(db, admin);
  assert.match(st.calendars.find((c) => c.id === 'faro-blu:airbnb').last_error, /non risponde/);
  // "Aggiorna ora" ripetuto subito: non riscarica
  const f = fetcherFor({ [AIRBNB_URL]: ics() });
  await syncAll(db, { fetcher: f, minAgeMs: 60000 });
  assert.equal(f.calls.length, 0);
});

test('durante il soggiorno cambia solo la partenza; i soggiorni iniziati non si cancellano', async () => {
  const { db, connect, bookings } = await setup();
  await connect('faro-blu:airbnb', AIRBNB_URL);
  const cal = await db.prepare("SELECT * FROM calendars WHERE id = 'faro-blu:airbnb'").first();
  await applyEvents(db, cal, parseIcs(ics(ev({ uid: 'a1', start: addDays(T, -2), end: addDays(T, 3) }))).events, T);
  let [b] = await bookings();
  db.sqlite.prepare("UPDATE bookings SET stage = 'in_casa' WHERE id = ?").run(b.id);
  await applyEvents(db, cal, parseIcs(ics(ev({ uid: 'a1', start: addDays(T, -1), end: addDays(T, 5) }))).events, T);
  [b] = await bookings();
  assert.equal(b.check_in, addDays(T, -2));
  assert.equal(b.check_out, addDays(T, 5));
  await applyEvents(db, cal, parseIcs(ics(ev({ uid: 'altro', start: addDays(T, 50), end: addDays(T, 52) }))).events, T);
  [b] = await bookings();
  assert.equal(b.stage, 'in_casa');
});
