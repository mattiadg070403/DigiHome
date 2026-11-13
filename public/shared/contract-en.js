// Contratto in inglese (per gli ospiti stranieri): stessa struttura e stesse clausole del testo italiano
// in contract.js, articolo per articolo. Se si cambia una clausola, va cambiata in tutti e due i file.

import { formatItDate, todayRome } from './dates.js';

const BLANK = '____________';

const ROLES_EN = {
  proprietario: 'owner',
  comproprietario: 'co-owner',
  usufruttuario: 'usufructuary',
  comodatario: 'holder under a loan-for-use agreement (comodato)',
};

/** Importi in inglese: "€300", "€0.40", "€1,250.50". */
export function euroEn(cents) {
  const c = Number.isInteger(cents) ? cents : 0;
  const int = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = c % 100;
  return `€${int}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

const date = (iso) => (iso ? formatItDate(iso) : BLANK);

export function guestParagraphEn(g = {}) {
  const val = (s) => (s ? s : BLANK);
  const sal = g.sal === 'F' ? 'Ms.' : 'Mr.';
  const cf = g.tax_code ? `, Italian tax code ${String(g.tax_code).toUpperCase()}` : '';
  return `${sal} ${val(g.name)}, born in ${val(g.birth_place)} on ${date(g.birth_date)}, residing in ${val(g.residence)}${cf}, `
    + `identity document no. ${val(String(g.doc_number || '').toUpperCase())}, hereinafter the “Tenant”;`;
}

function landlordParagraph(info) {
  const role = ROLES_EN[info.landlord_role] || BLANK;
  return `${info.landlord_sal === 'F' ? 'Ms.' : 'Mr.'} ${info.landlord_name || BLANK}, born in ${info.landlord_birth_place || BLANK} `
    + `on ${date(info.landlord_birth_date)}, residing in ${info.landlord_residence || BLANK}, acting as ${role} of the property, hereinafter the “Landlord”;`;
}

export function privacyNoticeEn(info, keepYears) {
  const owner = info.landlord_name || 'the Landlord';
  return [
    `Data controller: ${owner}${info.privacy_contact ? ` (contact: ${info.privacy_contact})` : ''}.`,
    'Data processed: name and surname, place and date of birth, address of residence, Italian tax code (if any), identity document number, signature and booking details.',
    'Purposes and legal basis: conclusion and performance of the rental agreement (Art. 6(1)(b) GDPR) and compliance with legal obligations (Art. 6(1)(c) GDPR). Without these data the agreement cannot be concluded.',
    `Retention: the signed agreement is stored electronically, in a protected archive with restricted access, for ${keepYears} years after the end of the stay and then deleted, unless a longer period is required by law or the agreement is needed to establish or defend a legal claim.`,
    'Disclosure: the data are not disseminated or transferred to third parties; they may be disclosed to the Authorities where required by law and are kept by the IT service providers hosting the archive, with data stored in the European Union.',
    'Rights: the data subject may ask the Controller for access to their data, rectification, erasure or restriction of processing, within the limits provided by law, and may lodge a complaint with the Italian Data Protection Authority (Garante per la protezione dei dati personali, www.garanteprivacy.it).',
  ];
}

/** Stessi blocchi di buildContract (contract.js), in inglese. */
export function buildContractEn({ house, info, booking: b, guest = null, signedAt = null, keepYears }) {
  const out = [];
  const add = (t, text) => out.push(text === undefined ? { t } : { t, text });
  let n = 0;
  const art = (title) => add('h', `Art. ${++n} – ${title}`);
  const city = info.city || 'Gallipoli';
  const description = info.description_en || info.description || BLANK;
  const quiet = info.quiet_hours_en || info.quiet_hours;
  const rules = info.extra_rules_en || info.extra_rules;

  add('title', 'TOURIST RENTAL AGREEMENT – SHORT-TERM LEASE');
  add('center', 'BETWEEN');
  add('p', landlordParagraph(info));
  add('center', 'AND');
  if (guest) add('p', guestParagraphEn(guest)); else add('guest');
  add('p', 'jointly, “the Parties”,');
  add('center', 'IT IS AGREED AS FOLLOWS.');

  art('Subject of the lease');
  add('p', `The Landlord leases to the Tenant, who accepts, the property located in ${city}, ${info.address || BLANK}, ${description}, fully furnished and equipped.`);
  add('p', 'The property is let exclusively for tourist purposes, in accordance with current legislation.');
  add('p', `National Identification Code (CIN): ${info.cin || BLANK}`);
  add('p', 'The Tenant declares that they have received information about the characteristics of the property and accept its state of repair, furnishings and equipment, except for anything reported upon arrival.');

  art('Duration');
  add('p', 'The lease has a fixed term:');
  add('li', `from ${formatItDate(b.check_in)} (check-in from ${house.checkin_time});`);
  add('li', `to ${formatItDate(b.check_out)} (check-out by ${house.checkout_time}).`);
  add('p', 'On expiry the agreement terminates automatically, without the need for notice. The Tenant undertakes to return the property free of people and belongings by the agreed time.');
  add('p', 'In the event of an unauthorised delay, the Landlord reserves the right to claim compensation for any damage and for documented additional costs arising from the delay, without prejudice to any further right provided by law.');

  art('Number of guests');
  add('p', 'The property may be occupied only by the persons indicated in the booking and identified in accordance with the law.');
  add('p', `Number of occupants indicated in the booking: ${b.guests} ${b.guests === 1 ? 'person' : 'persons'}.`);
  add('p', 'Overnight stays or use of the property by persons other than those indicated in the booking are not permitted without the Landlord’s prior written authorisation.');
  add('p', 'Any breach constitutes a serious breach of contract and may lead to termination of the agreement in the cases and manner provided by law, without prejudice to the right to compensation for any damage.');

  art('Tenant’s obligations');
  add('p', 'The Tenant undertakes to:');
  [
    'use the property exclusively for tourist purposes;',
    'look after the property, the furnishings and all equipment with due care;',
    'return the property in the same condition in which it was received, except for normal wear and tear;',
    'promptly report any faults, malfunctions or damage;',
    'comply with the building rules and with the rules of good neighbourliness;',
    quiet ? `respect quiet hours, indicatively ${quiet};` : null,
    'switch off lights, air conditioners and electrical appliances when not needed and before leaving the property;',
    'leave the kitchen tidy, washing the dishes, pots and utensils used during the stay;',
    `dispose of waste in the appropriate containers according to the separate waste collection rules and schedule of the Municipality of ${city}, without leaving rubbish bags inside the property on departure.`,
  ].filter(Boolean).forEach((x) => add('li', x));
  add('p', 'The following are prohibited:');
  [
    'subletting or granting the property to third parties;',
    'organising parties, events or gatherings;',
    'disturbing the neighbours;',
    'using the property for unlawful activities;',
    'altering the systems, furnishings or equipment of the property;',
    'smoking inside the property.',
  ].forEach((x) => add('li', x));
  add('p', 'Smoking is permitted only in any outdoor areas, taking care not to cause disturbance and not to leave cigarette butts.');
  if (rules) {
    add('p', 'Specific house rules:');
    for (const line of rules.split('\n')) if (line.trim()) add('li', line.trim().replace(/^[-–•]\s*/, ''));
  }

  art('Presence and responsibility of minors');
  add('p', 'Minors staying in the property must be accompanied and constantly supervised by at least one adult exercising parental responsibility or having lawful custody of them throughout the stay.');
  add('p', 'The Tenant and the other adult guests accompanying them are responsible for the supervision, custody and behaviour of the minors in the property and any appurtenances, and are liable for any damage caused to the property, furnishings, equipment or third parties, within the limits provided by law.');
  add('p', 'The Landlord assumes no obligation to supervise the minors in the property, without prejudice to compliance with legal obligations regarding the safety of the property.');

  art('Check-in, identification of guests and mandatory reporting');
  add('p', 'Before entering the property, the Tenant must allow the identification of themselves and of all occupants, including minors, by means of valid identity documents and in the manner permitted by current legislation. This is necessary to allow the Landlord to make the mandatory communication of the guests’ details to the competent Authorities through the Alloggiati Web portal.');
  add('p', 'Failure to complete the identification procedures may prevent the handover of the property, in accordance with the law.');
  add('p', 'Personal data and document details will be processed exclusively for the purposes required by current legislation and for purposes related to the management of the stay. Any copies of documents obtained in order to enter the data in the Alloggiati Web portal will be deleted or destroyed once the obligation has been fulfilled and the relevant receipt issued, unless otherwise required by law.');

  art('Rent');
  add('p', 'The rent is the amount agreed between the Parties before the booking was concluded, as shown in the relevant written confirmation (including one sent by message), in the payment receipt or in any other document suitable to prove the amount and method of payment.');

  art('Advance payment, balance and cancellation');
  add('p', `At the time of booking the Tenant pays an advance payment${info.advance_pct ? ` of approximately ${info.advance_pct}% of the rent` : ''}, in the amount stated in the written confirmation. The balance is due on arrival, unless otherwise agreed in writing between the Parties.`);
  add('p', 'If the Tenant cancels, at any time, or fails to arrive, the advance payment is retained by the Landlord and is non-refundable.');
  add('p', 'In the event of late arrival or early departure compared to the agreed dates, the rent remains due in full.');
  add('p', 'If the lease cannot take place for reasons attributable to the Landlord, the advance payment is refunded to the Tenant in full, without prejudice to the provisions of the law.');

  art('Costs and consumption');
  add('p', 'The rent includes:');
  add('li', 'water consumption;');
  add('li', 'final cleaning;');
  if (b.linens && b.towels) add('li', 'initial supply of bed and bath linen (sheets and towels).');
  else if (b.linens) { add('li', 'initial supply of bed linen.'); add('p', 'Towels are not included.'); }
  else if (b.towels) { add('li', 'initial supply of towels.'); add('p', 'Bed linen is not included.'); }
  else add('p', 'Bed linen and towels are not included.');
  if (info.kwh_day) {
    add('p', `Electricity consumption up to ${info.kwh_day} kWh per day of stay is also included. Any consumption exceeding this threshold will be charged at ${euroEn(info.kwh_price_cents)} per additional kWh.`);
    add('p', 'The meter will be read on arrival and on departure by direct reading or photographic record. Any excess will be calculated by multiplying the kWh exceeding the total threshold for the length of the stay by the unit cost indicated above; the amount will be communicated to the Tenant and must be paid at the end of the stay, upon documentation of the readings taken.');
  } else {
    add('p', 'Electricity consumption is also included, within the limits of normal use.');
  }
  add('p', `The tourist tax is not included in the rent and is payable separately, according to the rates and exemptions set by the Municipality of ${city}.`);

  art('Security deposit');
  if (b.security_cents > 0) {
    add('p', `The Tenant pays a security deposit of ${euroEn(b.security_cents)} as a guarantee of the proper fulfilment of the contractual obligations.`);
    add('p', 'The deposit will be returned at the end of the stay, after checking the condition of the premises and equipment and compliance with the contractual obligations.');
    add('p', 'The Landlord may retain all or part of the deposit solely to cover any damage, excess consumption or documented costs attributable to the Tenant, stating the reasons. Should the damage or the sums due exceed the amount of the deposit, the Tenant shall pay the difference.');
    add('p', 'The deposit is not a penalty and does not entail the automatic loss of the entire amount in the event of breaches.');
  } else {
    add('p', 'No security deposit is required for this stay. The Tenant remains liable for any damage, excess consumption or documented costs attributable to them, as provided in this agreement.');
  }

  art('Damage and faults');
  add('p', 'The Tenant is liable for damage caused to the property, furnishings, appliances, systems and common areas during the stay, except for normal wear and tear.');
  add('p', 'Any faults, malfunctions or damage already present on arrival must be reported to the Landlord by the day of check-in, preferably with photographs. The Tenant must promptly report any damage occurring during the stay, preventing it from worsening where possible.');

  art('Access to the property');
  add('p', 'The Landlord, directly or through a person appointed by them, may access the property, with reasonable notice and in agreement with the Tenant, to check any problems, carry out necessary or urgent maintenance and verify the condition of the property.');
  add('p', 'In the event of an emergency or imminent danger to persons or property, access may take place without notice, within the limits permitted by law.');

  art('Personal belongings left behind');
  add('p', 'Before departure the Tenant must check that no personal belongings have been left in the property. The Landlord is not liable for personal belongings left behind, except in the cases of liability provided by law.');

  art('Force majeure');
  add('p', 'Neither Party shall be liable for non-performance due to force majeure, such as natural disasters, orders of the Authorities or other unforeseeable and unavoidable events, within the limits and in accordance with the law.');

  art('Processing of personal data');
  add('p', 'The Parties acknowledge that personal data will be processed exclusively for the performance of this agreement and for the obligations required by law, in compliance with Regulation (EU) 2016/679 (GDPR) and current Italian legislation. The Tenant declares that they have received and read the notice on the processing of their personal data set out at the end of this agreement.');

  art('Electronic signature');
  add('p', 'This agreement is signed by the Parties by means of a handwritten signature applied on an electronic device, which constitutes an electronic signature under Regulation (EU) No 910/2014 and Italian Legislative Decree No 82/2005. The date and time of signature and a digital fingerprint (SHA-256) guaranteeing its integrity are associated with the document. A copy of the agreement in PDF format is given to the Tenant.');

  art('Applicable law and language');
  add('p', 'This agreement is governed by Italian law. For anything not expressly provided for herein, the provisions of the Italian Civil Code, of Italian legislation on tourist rentals and of the other applicable provisions shall apply. This agreement has been drawn up in English at the Tenant’s request.');

  art('Acceptance');
  add('p', 'The Tenant declares that they have received sufficient information about the characteristics of the property, have viewed it through the description and photographs provided, and accept its state of repair, furnishings and all the terms of this agreement, except for normal wear and tear and anything reported at check-in.');

  add('place', `${city}, ${signedAt ? formatItDate(todayRome(new Date(signedAt))) : '____ / ____ / ______'}`);
  out.push({ t: 'sign', host: info.landlord_name || '', guest: guest ? guest.name : '' });

  add('privacy-h', 'Notice on the processing of personal data (Art. 13 of Regulation (EU) 2016/679)');
  for (const p of privacyNoticeEn(info, keepYears)) add('privacy', p);
  return out;
}
