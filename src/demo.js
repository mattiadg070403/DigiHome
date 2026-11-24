// Dati inventati per la beta. Nomi e numeri non appartengono a persone reali.
// Disponibile solo se ALLOW_DEMO = "true" (ambiente di prova).

import { addDays, todayRome } from '../public/shared/dates.js';
import { DEFAULT_ACCOUNTING, stayAccount } from '../public/shared/accounting.js';
import { guestMissing } from '../public/shared/alloggiati.js';

const REV_NEXT = "(SELECT value FROM meta WHERE key = 'rev') + 1";

export function demoBookings(today = todayRome()) {
  const d = (n) => addDays(today, n);
  const steps = (keys) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, 1])));
  return [
    // Isola Bella
    { house_id: 'isola-bella', channel: 'diretto', guest_name: 'Famiglia Conti (prova)', phone: '+39 000 000 0001', guests: 4,
      check_in: d(-3), check_out: d(2), arrival_time: '16:00', total_cents: 98000, deposit_cents: 30000, deposit_paid: 1,
      security_cents: 20000, security_status: 'incassata', stage: 'in_casa', deposit_method: 'bonifico', balance_method: 'contanti',
      checkin_steps: steps(['ospiti', 'documenti', 'pagamenti', 'contratto', 'contatori', 'alloggiati', 'dms']),
      extras: [{ kind: 'tassa_soggiorno', amount_cents: 2000, paid: 1, paid_method: 'contanti' }] },
    { house_id: 'isola-bella', channel: 'airbnb', guest_name: 'Lena Hoffmann (prova)', phone: null, guests: 2,
      check_in: d(2), check_out: d(9), arrival_time: null, total_cents: 112000, security_cents: 0, security_status: 'nessuna', stage: 'confermata', extras: [{ kind: 'altro', label: 'Garage', amount_cents: 1500, paid: 0 }] },
    { house_id: 'isola-bella', channel: 'diretto', guest_name: 'Giulia Ferri (prova)', phone: '+39 000 000 0002', guests: 3,
      check_in: d(12), check_out: d(19), total_cents: 126000, deposit_cents: 30000, deposit_paid: 0,
      security_cents: 20000, security_status: 'da_incassare', stage: 'confermata', minors_delegation: 'da_chiedere' },
    // Arrivata dal calendario di Airbnb: nome, persone e telefono da completare.
    { house_id: 'isola-bella', channel: 'airbnb', guest_name: 'Ospite Airbnb (prova)', guests: 1,
      check_in: d(24), check_out: d(28), total_cents: 0, security_cents: 0, security_status: 'nessuna', stage: 'confermata',
      ext_uid: 'prova-1@airbnb.com', needs_details: 1 },
    { house_id: 'isola-bella', channel: 'booking', guest_name: 'Pierre Laurent (prova)', guests: 2,
      check_in: d(-20), check_out: d(-13), total_cents: 84000, security_status: 'nessuna', stage: 'chiusa', review_ok: 1,
      payout_cents: 52786, payout_at: d(-19),
      extras: [{ kind: 'tassa_soggiorno', amount_cents: 1400, paid: 1, paid_method: 'contanti' }],
      costs: [{ category: 'pulizie', label: 'Pulizie finali', amount_cents: 6000, paid: 1 }, { category: 'lavanderia', label: null, amount_cents: 2500, paid: 1 }],
      checkin_steps: steps(['ospiti', 'documenti', 'pagamenti', 'contratto', 'alloggiati', 'dms']), checkout_steps: steps(['controllo', 'chiavi']) },
    // Faro Blu
    // Check-in lasciato a metà due giorni fa: mancano Alloggiati e DMS, quindi è oltre le 24 ore.
    { house_id: 'faro-blu', channel: 'diretto', guest_name: 'Coppia Rizzi (prova)', phone: '+39 000 000 0005', guests: 2,
      check_in: d(-2), check_out: d(0), arrival_time: '15:00', total_cents: 36000, deposit_cents: 10000, deposit_paid: 1,
      security_cents: 0, security_status: 'nessuna', stage: 'confermata',
      checkin_steps: steps(['ospiti', 'documenti', 'pagamenti', 'contratto']),
      people: [
        { last_name: 'Rizzi', first_name: 'Paolo', sex: 'M', birth_date: '1985-04-12', birth_place: '475000001', citizenship: '100000100', residence: '475000002', doc_type: 'IDELE', doc_number: 'CA00000AA', doc_place: '475000002' },
        { last_name: 'Rizzi', first_name: 'Elena', sex: 'F', birth_date: '1987-09-30', birth_place: '475000003', citizenship: '100000100', residence: '475000002' },
      ] },
    { house_id: 'faro-blu', channel: 'booking', guest_name: 'Gruppo Ferraro (prova)', phone: '+39 000 000 0003', guests: 9,
      check_in: d(0), check_out: d(7), arrival_time: '16:30', total_cents: 245000, security_cents: 30000,
      security_status: 'da_incassare', stage: 'confermata', checkin_steps: steps(['ospiti']),
      people: [
        { last_name: 'Ferraro', first_name: 'Davide', sex: 'M', birth_date: '1990-02-02', birth_place: '475000004', citizenship: '100000100', residence: '475000004', doc_type: 'PATEN', doc_number: 'NA0000000X', doc_place: '475000004' },
        { last_name: 'Schmidt', first_name: 'Jonas', sex: 'M', birth_date: '1991-06-15', birth_place: '100000901', citizenship: '100000901', residence: '100000901' },
        { last_name: 'Ferraro', first_name: 'Chiara' },
      ] },
    { house_id: 'faro-blu', channel: 'diretto', guest_name: 'Marco Bellini (prova)', phone: '+39 000 000 0004', guests: 8,
      check_in: d(9), check_out: d(16), total_cents: 210000, deposit_cents: 50000, deposit_paid: 1,
      security_cents: 30000, security_status: 'da_incassare', stage: 'confermata' },
    { house_id: 'faro-blu', channel: 'airbnb', guest_name: 'Sophie Weber (prova)', guests: 6,
      check_in: d(-9), check_out: d(-2), total_cents: 168000, security_cents: 30000, security_status: 'restituita', stage: 'partita',
      extras: [{ kind: 'tassa_soggiorno', amount_cents: 4200, paid: 1, paid_method: 'contanti' }, { kind: 'altro', label: 'Pulizie finali (chieste a parte)', amount_cents: 8000, paid: 1, paid_method: 'contanti' }],
      costs: [{ category: 'pulizie', label: 'Pulizie finali', amount_cents: 9000, paid: 0, notes: 'Da pagare a Rosa con le prossime' }, { category: 'lavanderia', label: null, amount_cents: 4500, paid: 1 }],
      checkin_steps: steps(['ospiti', 'documenti', 'pagamenti', 'contratto', 'alloggiati', 'dms']), checkout_steps: steps(['controllo', 'chiavi', 'cauzione']) },
    ...demoHistory(today),
    ...demoNextSeason(today),
  ];
}

/** Due prenotazioni già arrivate per la prossima stagione (per vedere il ritmo nel listino). */
function demoNextSeason(today) {
  const y = Number(today.slice(0, 4)) + (Number(today.slice(5, 7)) > 9 ? 1 : 0);
  const list = [
    { house_id: 'faro-blu', channel: 'airbnb', guest_name: 'Famiglia Greco (prova)', guests: 8, check_in: `${y}-08-07`, total_cents: 245000, booked_on: addDays(today, -12) },
    { house_id: 'faro-blu', channel: 'diretto', guest_name: 'Luca Marino (prova)', guests: 6, check_in: `${y}-08-14`, total_cents: 238000, booked_on: addDays(today, -4), deposit_cents: 70000, deposit_paid: 1 },
    { house_id: 'isola-bella', channel: 'booking', guest_name: 'Anna Schulz (prova)', guests: 3, check_in: `${y}-07-17`, total_cents: 154000, booked_on: addDays(today, -7) },
  ];
  return list.filter((b) => b.check_in > addDays(today, 30)).map((b) => ({ ...b, check_out: addDays(b.check_in, 7), security_cents: 0, security_status: 'nessuna', stage: 'confermata' }));
}

/**
 * Soggiorni estivi degli ultimi due anni (inventati), per vedere il prezzo consigliato dei preventivi.
 * Chiusi, con il prezzo; a notte: Faro Blu ~200-320 €, Isola Bella ~140-230 € (l'anno prima un po' meno).
 */
function demoHistory(today) {
  const y0 = Number(today.slice(0, 4));
  const out = [];
  const weeks = [['06-06', 200], ['06-20', 220], ['07-04', 260], ['07-18', 280], ['08-01', 310], ['08-15', 330], ['08-22', 300], ['09-05', 220], ['09-19', 190]];
  const channels = ['diretto', 'airbnb', 'booking'];
  const done = JSON.stringify({ ospiti: 1, documenti: 1, pagamenti: 1, contratto: 1, alloggiati: 1, dms: 1 });
  const out_ = JSON.stringify({ controllo: 1, chiavi: 1, cauzione: 1 });
  for (const back of [0, 1, 2]) {
    const y = y0 - back;
    weeks.forEach(([md, eur], i) => {
      for (const [house, factor, guests] of [['faro-blu', 1, 8], ['isola-bella', 0.7, 4]]) {
        const ci = `${y}-${md}`;
        if (addDays(ci, 7) >= today) continue;
        const channel = channels[(i + back) % 3];
        const perNight = Math.round(eur * factor * (back === 2 ? 0.95 : back === 1 ? 1 : 1.05)) * 100;
        const b = { house_id: house, channel, guest_name: `${back ? 'Storico' : 'Ospite'} ${y} n. ${i + 1} (prova)`, guests,
          check_in: ci, check_out: addDays(ci, 7), total_cents: perNight * 7, security_cents: 0, security_status: 'nessuna', stage: 'chiusa', review_ok: 1,
          checkin_steps: done, checkout_steps: out_,
          // Prenotata da 3 a 7 mesi prima (agosto prima di giugno, come succede davvero): serve al ritmo del listino.
          booked_on: addDays(ci, -(220 - i * 12 - (house === 'faro-blu' ? 0 : 15))) };
        if (channel === 'diretto') Object.assign(b, { deposit_cents: Math.round((b.total_cents * 0.3) / 5000) * 5000, deposit_paid: 1, deposit_method: 'bonifico', balance_method: i % 2 ? 'contanti' : 'bonifico' });
        if (back === 0) {
          // Stagione in corso: tassa di soggiorno, pulizie e lavanderia di ogni soggiorno; qualche cosa lasciata da sistemare.
          b.extras = [{ kind: 'tassa_soggiorno', amount_cents: guests * 7 * 150, paid: 1, paid_method: 'contanti' }];
          if (i === 2) b.extras.push({ kind: 'altro', label: 'Garage', amount_cents: guests * 1000, paid: 1, paid_method: 'contanti' });
          b.costs = [
            { category: 'pulizie', label: 'Pulizie finali', amount_cents: house === 'faro-blu' ? 9000 : 6000, paid: i === 8 ? 0 : 1, notes: i === 8 ? 'Da pagare a fine mese' : null },
            { category: 'lavanderia', label: null, amount_cents: guests * 600, paid: 1 },
          ];
          if (i === 4 && house === 'faro-blu') Object.assign(b, { security_cents: 30000, security_status: 'trattenuta', security_withheld_cents: 12000, security_note: 'Tavolino del terrazzo rotto' });
        }
        // Pagamento delle piattaforme arrivato (tranne uno di quest'anno, per vedere l'avviso).
        if (channel !== 'diretto' && !(back === 0 && i === 7)) {
          const a = stayAccount(b, { settings: DEFAULT_ACCOUNTING });
          Object.assign(b, { payout_cents: a.expectedPayout, payout_at: addDays(ci, 1) });
        }
        out.push(b);
      }
    });
  }
  return out;
}

export function demoTasks(today = todayRome()) {
  return [
    { title: 'Pulizie e cambio biancheria', house_id: 'isola-bella', due_date: addDays(today, 2) },
    { title: 'Chiedere l’orario di arrivo a Lena Hoffmann', house_id: 'isola-bella', due_date: addDays(today, 1) },
    { title: 'Controllo dell’estintore', house_id: 'faro-blu', due_date: addDays(today, -1) },
  ];
}

/** Cancella prenotazioni, note e cose da fare e carica i dati di prova. */
// Luoghi e documenti di prova (codici inventati, tranne Italia 100000100).
export const DEMO_PLACES = [
  ['100000100', 'ITALIA', null, 'S'], ['100000901', 'GERMANIA', null, 'S'], ['100000902', 'FRANCIA', null, 'S'],
  ['100000903', 'REGNO UNITO', null, 'S'], ['100000904', 'SVIZZERA', null, 'S'], ['100000905', 'PAESI BASSI', null, 'S'],
  ['100000906', 'SPAGNA', null, 'S'], ['100000907', 'STATI UNITI D\'AMERICA', null, 'S'],
  ['475000001', 'GALLIPOLI', 'LE', 'C'], ['475000002', 'LECCE', 'LE', 'C'], ['475000003', 'BARI', 'BA', 'C'],
  ['475000004', 'NAPOLI', 'NA', 'C'], ['475000005', 'ROMA', 'RM', 'C'], ['475000006', 'MILANO', 'MI', 'C'],
  ['475000007', 'TORINO', 'TO', 'C'], ['475000008', 'BOLOGNA', 'BO', 'C'], ['475000009', 'GALATINA', 'LE', 'C'],
];
const DEMO_DOCS = [['IDENT', 'CARTA DI IDENTITA\''], ['IDELE', 'CARTA IDENTITA\' ELETTRONICA'], ['PASOR', 'PASSAPORTO ORDINARIO'], ['PATEN', 'PATENTE DI GUIDA']];

export async function loadDemo(db, user) {
  const at = new Date().toISOString();
  const stmts = [
    db.prepare('DELETE FROM pay_receipts'),
    db.prepare('DELETE FROM price_lists'),
    db.prepare('DELETE FROM market_prices'),
    db.prepare('DELETE FROM market_jobs'),
    db.prepare('DELETE FROM market_comps'),
    db.prepare('DELETE FROM contracts'),
    db.prepare('DELETE FROM guests'),
    db.prepare('DELETE FROM alloggiati_receipts'),
    db.prepare('DELETE FROM booking_extras'),
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM remittances'),
    db.prepare('DELETE FROM deadlines'),
    db.prepare('DELETE FROM booking_notes'),
    db.prepare('DELETE FROM tasks'),
    db.prepare('DELETE FROM bookings'),
    db.prepare("DELETE FROM audit_log WHERE entity IN ('booking', 'note', 'task', 'extra', 'expense', 'deadline', 'contract', 'remittance', 'guest')"),
  ];
  // Dati del contratto inventati, solo dove mancano (quelli scritti in Impostazioni non si toccano).
  const fake = { landlord_sal: 'M', landlord_name: 'Mario Rossi (prova)', landlord_birth_place: 'Lecce', landlord_birth_date: '1970-01-01',
    landlord_residence: 'Gallipoli, Via di Prova 1', landlord_role: 'proprietario', city: 'Gallipoli', address: 'Via di Prova n. 1',
    description: 'piano primo, composta da tre vani, cucina e servizi', description_en: 'first floor, consisting of three rooms, kitchen and bathroom', cin: 'IT075031C2PROVA0001', advance_pct: 30 };
  stmts.push(db.prepare(`UPDATE houses SET contract_info = json_patch(?, COALESCE(contract_info, '{}')), version = version + 1, rev = ${REV_NEXT}
    WHERE json_extract(COALESCE(contract_info, '{}'), '$.landlord_name') IS NULL`).bind(JSON.stringify(fake)));
  const cedolarePast = new Map();
  let demoCode = 100000;
  // Tabelle dei luoghi e dei documenti: quelle vere arrivano dal portale Alloggiati; qui, se mancano, poche di prova
  // (codici inventati, tranne Italia). Non sostituiscono mai le tabelle vere già scaricate.
  for (const [code, name, prov, kind] of DEMO_PLACES) {
    stmts.push(db.prepare(`INSERT OR IGNORE INTO places (code, name, province, kind, active)
      SELECT ?, ?, ?, ?, 1 WHERE (SELECT COUNT(*) FROM places) < 100`).bind(code, name, prov, kind));
  }
  for (const [code, name] of DEMO_DOCS) {
    stmts.push(db.prepare(`INSERT OR IGNORE INTO doc_types (code, name) SELECT ?, ? WHERE (SELECT COUNT(*) FROM doc_types) < 10`).bind(code, name));
  }
  // DMS: camere e posti letto di prova, solo se non impostati.
  stmts.push(db.prepare(`UPDATE houses SET dms_settings = CASE id WHEN 'faro-blu' THEN '{"rooms":3,"beds":9}' ELSE '{"rooms":2,"beds":4}' END
    WHERE dms_settings IS NULL`));
  for (const b of demoBookings()) {
    const row = {
      id: crypto.randomUUID(), phone: null, arrival_time: null, deposit_cents: 0, deposit_paid: 0, security_cents: 0,
      minors_delegation: 'non_serve', checkin_steps: '{}', checkout_steps: '{}', review_ok: null, ...b,
    };
    const extras = row.extras || [];
    const costs = row.costs || [];
    const people = row.people || [];
    delete row.extras;
    delete row.costs;
    delete row.people;
    if (people.length) {
      row.guests_entered = people.length;
      row.guests_done = people.filter((g, i) => !guestMissing(g, i === 0).length).length;
    }
    const cols = Object.keys(row);
    stmts.push(db.prepare(`INSERT INTO bookings (${cols.join(', ')}, created_at, created_by, updated_at, updated_by, rev)
      VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ${REV_NEXT})`)
      .bind(...cols.map((c) => row[c]), at, user.email, at, user.email));
    for (const x of extras) {
      stmts.push(db.prepare(`INSERT INTO booking_extras (id, booking_id, kind, label, amount_cents, paid, paid_method, created_at, created_by, rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})`).bind(crypto.randomUUID(), row.id, x.kind, x.label || null, x.amount_cents, x.paid, x.paid_method || null, at, user.email));
    }
    people.forEach((g, i) => {
      demoCode += 1;
      stmts.push(db.prepare(`INSERT INTO guests (id, booking_id, position, code, last_name, first_name, sex, birth_date, birth_place, citizenship, residence,
          doc_type, doc_number, doc_place, complete, created_at, created_by, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})`)
        .bind(crypto.randomUUID(), row.id, i, demoCode, g.last_name, g.first_name, g.sex || null, g.birth_date || null, g.birth_place || null,
          g.citizenship || null, g.residence || null, g.doc_type || null, g.doc_number || null, g.doc_place || null,
          guestMissing(g, i === 0).length ? 0 : 1, at, user.email));
    });
    for (const x of costs) {
      stmts.push(db.prepare(`INSERT INTO expenses (id, house_id, category, label, amount_cents, date, paid, paid_at, notes, booking_id, created_at, created_by, rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})`)
        .bind(crypto.randomUUID(), row.house_id, x.category, x.label || null, x.amount_cents, row.check_out, x.paid, x.paid ? at : null, x.notes || null, row.id, at, user.email));
    }
    // Anni passati: cedolare già versata (per non vederla tra le cose da sistemare).
    const y = Number(row.check_in.slice(0, 4));
    if (y < Number(todayRome().slice(0, 4))) {
      const a = stayAccount(row, { settings: DEFAULT_ACCOUNTING });
      const k = `${row.house_id}|${y}`;
      cedolarePast.set(k, (cedolarePast.get(k) || 0) + a.cedolareToPay);
    }
  }
  for (const [k, cents] of cedolarePast) {
    if (!cents) continue;
    const [house, y] = k.split('|');
    stmts.push(db.prepare(`INSERT INTO remittances (id, house_id, kind, year, amount_cents, date, notes, created_at, created_by, updated_at, updated_by, rev)
      VALUES (?, ?, 'cedolare', ?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})`).bind(crypto.randomUUID(), house, Number(y), cents, `${Number(y) + 1}-06-16`, 'F24 (prova)', at, user.email, at, user.email));
  }
  for (const t of demoTasks()) {
    stmts.push(db.prepare(`INSERT INTO tasks (id, title, house_id, due_date, created_at, created_by, rev)
      VALUES (?, ?, ?, ?, ?, ?, ${REV_NEXT})`).bind(crypto.randomUUID(), t.title, t.house_id, t.due_date, at, user.email));
  }
  // Archivio della casa: qualche spesa e scadenza di prova.
  const today = todayRome();
  const day = (n) => addDays(today, n);
  const expenses = [
    ['isola-bella', 'acqua_condominio', 'Rata condominio 4° trimestre', 18000, day(-20), day(-110), day(-20), null, 1],
    ['isola-bella', 'acquisti', 'Detersivi e carta', 3450, day(-6), null, null, null, 1],
    ['isola-bella', 'luce', 'Bolletta luglio–agosto', 8450, day(-15), day(-130), day(-70), null, 1],
    ['faro-blu', 'tari', 'TARI 2a rata', 21600, day(-3), null, null, day(5), 0],
    ['faro-blu', 'pulizie', 'Pulizie dopo il soggiorno', 6000, day(-2), null, null, null, 1],
    ['faro-blu', 'manutenzione', 'Idraulico: sifone cucina', 9000, day(-12), null, null, null, 1],
  ];
  for (const [house, cat, label, cents, date, from, to, due, paid] of expenses) {
    stmts.push(db.prepare(`INSERT INTO expenses (id, house_id, category, label, amount_cents, date, period_from, period_to, due_date, paid, paid_at, created_at, created_by, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})`)
      .bind(crypto.randomUUID(), house, cat, label, cents, date, from, to, due, paid, paid ? at : null, at, user.email));
  }
  const deadlines = [
    [null, 'Versamento tassa di soggiorno al Comune', day(4), 'quarterly', 10],
    ['isola-bella', 'Revisione estintore', day(40), 'yearly', 30],
    ['faro-blu', 'Rinnovo assicurazione casa', day(-1), 'yearly', 30],
  ];
  for (const [house, title, due, repeat, notice] of deadlines) {
    stmts.push(db.prepare(`INSERT INTO deadlines (id, house_id, title, due_date, "repeat", notice_days, created_at, created_by, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${REV_NEXT})`).bind(crypto.randomUUID(), house, `${title} (prova)`, due, repeat, notice, at, user.email));
  }
  stmts.push(db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'"));
  stmts.push(db.prepare(`INSERT INTO audit_log (at, user_email, entity, entity_id, action) VALUES (?, ?, 'demo', 'all', 'load')`)
    .bind(at, user.email));
  await db.batch(stmts);
}
