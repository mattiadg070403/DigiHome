import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser } from './d1.js';
import { runOp } from '../src/ops.js';
import { readState } from '../src/state.js';
import { marketTick, requestRefresh, startDiscovery } from '../src/market.js';
import { amenityKeys, amenityReport, checkMarketSettings, listingIdFromUrl, marketAdvice, moneyToCents, parseCoords, readListing, readPrice, similarity, weekMarket } from '../public/shared/market.js';

const ENV = { APIFY_TOKEN: 'apify_api_test_token_0000000000' };

test('lettura dei risultati: importi, prezzo per l’ospite, pulizie, dotazioni, camere', () => {
  assert.equal(moneyToCents('€1,234.50'), 123450);
  assert.equal(moneyToCents('1.234,50 €'), 123450);
  assert.equal(moneyToCents('€ 980'), 98000);
  assert.equal(moneyToCents('abc'), null);
  const p = readPrice({ breakDown: { basePrice: { price: '€1,400' }, cleaningFee: { description: 'Cleaning fee', price: '€60' }, serviceFee: { price: '€0' }, totalBeforeTaxes: { price: '€1,460' } } });
  assert.deepEqual(p, { available: true, total_cents: 146000, cleaning_cents: 6000 });
  assert.equal(readPrice(null).available, false);
  assert.deepEqual(amenityKeys([{ values: [{ title: 'Air conditioning', available: true }, { title: 'Pool table', available: true }, { title: 'Sea view', available: true }, { title: 'Wifi', available: false }] }]), ['aria_condizionata', 'vista_mare']);
  const l = readListing({ id: '123', title: 'Casa', personCapacity: 6, subDescription: { items: ['6 guests', '3 bedrooms'] }, coordinates: { latitude: 40.05, longitude: 17.99 },
    rating: { guestSatisfaction: 4.8, reviewsCount: 40 }, host: { name: 'Nome Persona' }, amenities: [] });
  assert.equal(l.bedrooms, 3);
  assert.equal(l.url, 'https://www.airbnb.it/rooms/123');
  assert.ok(!JSON.stringify(l).includes('Nome Persona')); // niente dati dell'host
  assert.deepEqual(parseCoords('40.0558, 17.9925'), { lat: 40.0558, lon: 17.9925 });
  assert.equal(parseCoords('via Roma'), null);
  assert.deepEqual(parseCoords('40,0558° N, 17,9925° E'), { lat: 40.0558, lon: 17.9925 }); // Mappe di Apple
  assert.equal(checkMarketSettings({ lat: 40, lon: 18, amenities: ['jacuzzi'] }).ok, false);
});

test('somiglianza: distanza, ospiti, camere; fuori raggio esclusa', () => {
  const house = { max_guests: 8 };
  const settings = { lat: 40.0558, lon: 17.9925, radius_km: 2, bedrooms: 3, amenities: ['aria_condizionata'] };
  const near = similarity({ coords: { lat: 40.056, lon: 17.993 }, capacity: 8, bedrooms: 3, amenities: ['aria_condizionata'], reviews: 50, rating: 4.9 }, { house, settings });
  const far = similarity({ coords: { lat: 40.2, lon: 18.2 }, capacity: 8, bedrooms: 3, amenities: [] }, { house, settings });
  const small = similarity({ coords: { lat: 40.056, lon: 17.993 }, capacity: 5, bedrooms: 3, amenities: [] }, { house, settings }); // 3 posti in meno
  const sixGuests = similarity({ coords: { lat: 40.056, lon: 17.993 }, capacity: 6, bedrooms: 3, amenities: ['aria_condizionata'] }, { house, settings: { ...settings, guests: 6 } });
  assert.ok(sixGuests && sixGuests.score < 1); // posti scelti nelle impostazioni
  assert.ok(near && near.score < 1);
  assert.equal(far, null);
  assert.equal(small, null);
});

test('sintesi della settimana e consigli sul prezzo', () => {
  const comps = Array.from({ length: 10 }, (_, i) => ({ house_id: 'faro-blu', listing_id: String(i), selected: 1, amenities: JSON.stringify(i < 8 ? ['aria_condizionata', 'wifi'] : ['wifi']) }));
  const rows = comps.map((c, i) => ({ house_id: 'faro-blu', listing_id: c.listing_id, week_start: '2027-07-10', status: i < 7 ? 'non_disponibile' : 'libera',
    week_cents: i < 7 ? null : 200000 + i * 1000, cleaning_cents: i % 2 ? 6000 : null, checked_at: '2027-03-01T10:00:00Z' }));
  const m = weekMarket(rows, comps, 'faro-blu', '2027-07-10');
  assert.deepEqual([m.checked, m.taken, m.free, m.takenPct, m.median], [10, 7, 3, 70, 208000]);
  // Settimana richiesta e tu sotto la media → alza.
  const up = marketAdvice(m, { myAirbnbWeek: 170000, net: 110000, daysToArrival: 120 });
  assert.match(up.text, /già prenotate.*valuta di alzare/);
  assert.ok(up.target > 110000 && up.pct > 0 && up.pct <= 15);
  // Molte libere, vicino alla data, tu sopra → scendi.
  const free = { ...m, taken: 2, free: 8, takenPct: 20 };
  const down = marketAdvice(free, { myAirbnbWeek: 260000, net: 160000, daysToArrival: 30 });
  assert.match(down.text, /ancora libere.*valuta di scendere/);
  assert.ok(down.target < 160000 && down.pct >= -15);
  // Troppo poche libere per un prezzo: solo il segnale della richiesta.
  const few = marketAdvice({ ...m, free: 1, taken: 9, takenPct: 90, median: null }, { myAirbnbWeek: 200000, net: 120000, daysToArrival: 100 });
  assert.match(few.text, /molto richiesta/);
  // Dotazioni: aria condizionata in 8 su 10 e tu no → consiglio; pulizie a parte.
  const rep = amenityReport(comps, 'faro-blu', { amenities: ['wifi'] }, rows);
  assert.ok(rep.tips.some((t) => /8 case simili su 10 hanno aria condizionata/.test(t.text)));
  assert.ok(rep.tips.some((t) => t.kind === 'pulizie'));
});

/** Apify finto per i test: registra le chiamate. */
function fakeApify() {
  const calls = [];
  const runs = new Map();
  const listing = (i, extra = {}) => ({ id: String(900 + i), title: `Casa ${i}`, personCapacity: 8, subDescription: { items: ['8 guests', '3 bedrooms'] },
    coordinates: { latitude: 40.0558 + i * 0.001, longitude: 17.9925 }, rating: { guestSatisfaction: 4.8, reviewsCount: 30 },
    amenities: [{ values: [{ title: 'Air conditioning', available: true }] }], ...extra });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, auth: opts.headers.Authorization, body: opts.body ? JSON.parse(opts.body) : null });
    const ok = (d) => new Response(JSON.stringify(d), { status: 200 });
    let m = /\/acts\/([^/]+)\/runs$/.exec(u.pathname);
    if (m) { const id = `r${runs.size + 1}`; runs.set(id, { actor: m[1], input: JSON.parse(opts.body) }); return ok({ data: { id, defaultDatasetId: `d${id}` } }); }
    m = /\/actor-runs\/(\w+)$/.exec(u.pathname);
    if (m) return ok({ data: { status: 'SUCCEEDED', defaultDatasetId: `d${m[1]}` } });
    m = /\/datasets\/d(\w+)\/items$/.exec(u.pathname);
    const run = runs.get(m[1]);
    if (run.actor.endsWith('airbnb-scraper')) return ok(Array.from({ length: 14 }, (_, i) => listing(i)));
    return ok(run.input.startUrls.map(({ url: lu }, k) => {
      const id = /rooms\/(\d+)/.exec(lu)[1];
      return k % 2 ? listing(Number(id) - 900, { price: null })
        : listing(Number(id) - 900, { price: { breakDown: { totalBeforeTaxes: { price: '€1,750' }, serviceFee: { price: '€0' } } } });
    }));
  };
  return { fetchImpl, calls };
}

test('flusso completo: ricerca → 10 scelte → prezzi per settimana; solo l’amministratore; chiave mai nello stato', async () => {
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', role: 'admin' });
  const collab = await addUser(db, { email: 'c@example.invalid', role: 'collaboratore' });
  const { fetchImpl, calls } = fakeApify();
  const opts = { fetchImpl, today: '2027-02-01' };
  await assert.rejects(startDiscovery(db, ENV, collab, 'faro-blu', opts), /amministratore/);
  await assert.rejects(startDiscovery(db, {}, admin, 'faro-blu', opts), /chiave di Apify/);
  await assert.rejects(startDiscovery(db, ENV, admin, 'faro-blu', opts), /posizione/);
  const h = await db.prepare("SELECT version FROM houses WHERE id = 'faro-blu'").first();
  await runOp(db, admin, { opId: crypto.randomUUID(), type: 'house.update', payload: { id: 'faro-blu', version: h.version, changes: { market_settings: { lat: 40.0558, lon: 17.9925, radius_km: 3, bedrooms: 3, amenities: ['aria_condizionata'] } } } });
  const t1 = await startDiscovery(db, ENV, admin, 'faro-blu', opts);
  assert.equal(t1.started, 1);
  await marketTick(db, ENV, opts); // legge i risultati della ricerca
  let comps = (await db.prepare("SELECT * FROM market_comps WHERE house_id = 'faro-blu'").all()).results;
  assert.equal(comps.length, 14);
  assert.equal(comps.filter((c) => c.selected).length, 10); // scelti in automatico i 10 più simili
  // Scelta a mano: solo l'amministratore, al massimo 10.
  const ids = comps.slice(0, 4).map((c) => c.listing_id);
  await assert.rejects(runOp(db, collab, { opId: crypto.randomUUID(), type: 'market.select', payload: { house_id: 'faro-blu', listing_ids: ids } }), /amministratore/);
  await assert.rejects(runOp(db, admin, { opId: crypto.randomUUID(), type: 'market.select', payload: { house_id: 'faro-blu', listing_ids: comps.map((c) => c.listing_id) } }), /al massimo 10/);
  await runOp(db, admin, { opId: crypto.randomUUID(), type: 'market.select', payload: { house_id: 'faro-blu', listing_ids: ids } });
  comps = (await db.prepare("SELECT * FROM market_comps WHERE house_id = 'faro-blu' AND selected = 1").all()).results;
  assert.equal(comps.length, 4);
  // Prezzi: un lavoro per settimana della stagione, al massimo 3 avviati per giro.
  const r = await requestRefresh(db, ENV, admin, 'faro-blu', opts);
  assert.equal(r.started, 3);
  for (let i = 0; i < 10; i++) await marketTick(db, ENV, opts);
  const prices = (await db.prepare("SELECT * FROM market_prices WHERE house_id = 'faro-blu'").all()).results;
  assert.equal(prices.length, 18 * 4);
  assert.equal(prices.filter((p) => p.status === 'libera').length, 18 * 2);
  assert.ok(prices.filter((p) => p.status === 'libera').every((p) => p.week_cents === 175000));
  // Premere di nuovo subito dopo non rifà niente (stessi dati, si spenderebbe per niente)...
  const again = await requestRefresh(db, ENV, admin, 'faro-blu', opts);
  assert.equal(again.queued, 0);
  assert.equal(again.fresh, 18);
  assert.equal(again.started, 0);
  // ...e mentre è in corso non mette niente in più in coda.
  await new Promise((r) => setTimeout(r, 5));
  await runOp(db, admin, { opId: crypto.randomUUID(), type: 'market.select', payload: { house_id: 'faro-blu', listing_ids: ids.slice(0, 3) } });
  const changed = await requestRefresh(db, ENV, admin, 'faro-blu', opts); // scelta cambiata → si rifà tutto
  assert.equal(changed.queued, 18);
  const during = await requestRefresh(db, ENV, admin, 'faro-blu', opts);
  assert.equal(during.queued, 0);
  assert.equal(during.already, 18);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM market_jobs WHERE kind = 'prices'").first()).n, 36); // niente doppioni
  for (let i = 0; i < 10; i++) await marketTick(db, ENV, opts);
  // La chiave va solo nell'intestazione verso Apify, mai negli input né nello stato.
  assert.ok(calls.every((c) => c.auth === `Bearer ${ENV.APIFY_TOKEN}`));
  assert.ok(!JSON.stringify(calls.map((c) => c.body)).includes(ENV.APIFY_TOKEN));
  const st = await readState(db, collab);
  assert.ok(!JSON.stringify(st).includes(ENV.APIFY_TOKEN));
  assert.equal(st.marketJobs.length, 0); // i lavori li vede solo l'amministratore
  assert.equal(st.marketPrices.length, 72);
});

test('case scelte da Mattia con il link: riconoscimento, priorità sulla ricerca, al massimo 10, si possono togliere', async () => {
  assert.equal(listingIdFromUrl('https://www.airbnb.it/rooms/12345678?adults=2&check_in=2027-07-03'), '12345678');
  assert.equal(listingIdFromUrl('airbnb.com/rooms/plus/987654'), '987654');
  assert.equal(listingIdFromUrl('https://m.airbnb.de/rooms/55555/'), '55555');
  assert.equal(listingIdFromUrl('https://www.booking.com/rooms/12345'), null);
  assert.equal(listingIdFromUrl('https://www.airbnb.it/s/Gallipoli/homes'), null);
  assert.equal(listingIdFromUrl('https://airbnb.it.evil.example/rooms/12345'), null);
  const db = freshDb();
  const admin = await addUser(db, { email: 'admin@example.invalid', role: 'admin' });
  const collab = await addUser(db, { email: 'c@example.invalid', role: 'collaboratore' });
  const add = (user, url) => runOp(db, user, { opId: crypto.randomUUID(), type: 'market.add', payload: { house_id: 'isola-bella', url } });
  await assert.rejects(add(collab, 'https://www.airbnb.it/rooms/11111'), /amministratore/);
  await assert.rejects(add(admin, 'https://www.airbnb.it/wishlists/1'), /Link non riconosciuto/);
  // 9 trovate dalla ricerca e già scelte, poi 2 aggiunte a mano: la seconda prende il posto della meno simile della ricerca.
  for (let i = 0; i < 9; i++) {
    await db.prepare(`INSERT INTO market_comps (id, house_id, listing_id, url, score, selected, found_at) VALUES (?, 'isola-bella', ?, ?, ?, 1, '2026-11-23')`)
      .bind(`isola-bella:${7000 + i}`, String(7000 + i), `https://www.airbnb.it/rooms/${7000 + i}`, i).run();
  }
  const a1 = await add(admin, 'https://www.airbnb.it/rooms/11111?x=1');
  assert.equal(a1.selected, 1);
  const a2 = await add(admin, 'https://www.airbnb.it/rooms/22222');
  assert.equal(a2.selected, 1);
  const sel = (await db.prepare("SELECT listing_id, source FROM market_comps WHERE house_id = 'isola-bella' AND selected = 1").all()).results;
  assert.equal(sel.length, 10);
  assert.ok(sel.some((r) => r.listing_id === '22222') && !sel.some((r) => r.listing_id === '7008')); // tolta la meno simile
  // Il controllo della prima settimana è in coda (porta titolo, posti e dotazioni).
  const jobs = (await db.prepare("SELECT * FROM market_jobs WHERE house_id = 'isola-bella' AND kind = 'prices'").all()).results;
  assert.equal(jobs.length, 1);
  // Togliere una casa aggiunta a mano cancella anche i suoi prezzi.
  await db.prepare("INSERT INTO market_prices (house_id, listing_id, week_start, status, checked_at) VALUES ('isola-bella', '11111', '2027-07-03', 'non_disponibile', 'x')").run();
  await runOp(db, admin, { opId: crypto.randomUUID(), type: 'market.remove', payload: { house_id: 'isola-bella', listing_id: '11111' } });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM market_prices WHERE listing_id = '11111'").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM market_comps WHERE listing_id = '11111'").first()).n, 0);
});
