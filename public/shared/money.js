// Importi: sempre centesimi interi. Usato sia dall'app sia dal server.

/** "1.150 €" oppure "1.150,50 €" */
export function fmtEuro(cents) {
  const c = Number.isInteger(cents) ? cents : 0;
  const neg = c < 0;
  const abs = Math.abs(c);
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  const int = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const body = rest ? `${int},${String(rest).padStart(2, '0')}` : int;
  return `${neg ? '−' : ''}${body} €`;
}

/**
 * Da testo scritto a centesimi. Accetta "1150", "1.150", "1150,5", "1.150,50", "1150.50".
 * Restituisce null se il testo non è un importo valido.
 */
export function parseEuro(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim().replace(/€/g, '').replace(/\s/g, '');
  if (s === '') return 0;
  if (!/^\d[\d.,]*$/.test(s)) return null;
  let intPart = s;
  let decPart = '';
  if (s.includes(',')) {
    // Uso italiano: virgola per i decimali, punti per le migliaia.
    if ((s.match(/,/g) || []).length > 1) return null;
    [intPart, decPart] = s.split(',');
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(intPart)) return null;
  } else if (/^\d+\.\d{1,2}$/.test(s)) {
    // Un solo punto seguito da 1-2 cifre: decimali scritti all'inglese ("1150.50").
    [intPart, decPart] = s.split('.');
  } else if (s.includes('.') && !/^\d{1,3}(\.\d{3})+$/.test(s)) {
    return null;
  }
  if (decPart.length > 2) return null;
  intPart = intPart.replace(/\./g, '');
  if (!/^\d+$/.test(intPart)) return null;
  const cents = Number(intPart) * 100 + Number((decPart + '00').slice(0, 2));
  return Number.isSafeInteger(cents) && cents <= 100000000 ? cents : null;
}

/** Valore da mostrare in un campo di testo: "1150" oppure "1150,50". */
export function centsToInput(cents) {
  if (!Number.isInteger(cents) || cents === 0) return '';
  const rest = cents % 100;
  return rest ? `${Math.floor(cents / 100)},${String(rest).padStart(2, '0')}` : String(cents / 100);
}
