// Bozza della prenotazione che si sta scrivendo, salvata su questo dispositivo.
// Serve se la pagina si ricarica, il browser chiude la scheda o si esce per sbaglio.
// Resta solo su questo dispositivo, si cancella al salvataggio e scade dopo 48 ore.

const KEY = 'dh.bozza.prenotazione';
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function readDraft() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || !d.v || Date.now() - d.at > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

/** draft: { mode: 'new'|'edit', id?, version?, v } */
export function writeDraft(draft) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...draft, at: Date.now() }));
  } catch { /* spazio non disponibile: si continua senza bozza */ }
}

export function clearDraft() {
  try { localStorage.removeItem(KEY); } catch { /* niente da fare */ }
}

/** Breve descrizione per il banner "Prenotazione non salvata". */
export function describeDraft(d, houses = []) {
  const house = houses.find((x) => x.id === d.v.house_id);
  const name = (d.v.guest_name || '').trim() || 'senza nome';
  return `${d.mode === 'edit' ? 'Modifiche non salvate' : 'Prenotazione non salvata'}: ${name}${house ? ` · ${house.name}` : ''}`;
}
