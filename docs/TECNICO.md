# Gestionale case vacanza — documento tecnico

Versione: beta 0.1 (7 novembre 2026). Requisiti e decisioni: documento di progetto `claude/gestionale-requisiti.md`.

## 1. Architettura

Un solo servizio su Cloudflare, senza server da mantenere e senza pause per inattività.

- **Cloudflare Worker** (`src/worker.js`): riceve ogni richiesta, controlla l'accesso, risponde alle API (`/api/...`) e serve l'app (cartella `public/`).
- **Cloudflare D1** (database SQLite gestito): tutti i dati. Struttura in `migrations/`.
- **Cloudflare Access** davanti all'indirizzo: solo le email autorizzate arrivano al Worker. Il Worker verifica di nuovo il token di Access e controlla che l'email sia nella tabella `users`, attiva.
- **App** (`public/`): HTML, CSS e JavaScript semplici, nessun framework, nessuna libreria esterna. Installabile su iPad (PWA).

Nessuna dipendenza da npm: meno componenti, meno aggiornamenti, meno rischi. I test usano solo gli strumenti inclusi in Node (`node:test`, `node:sqlite`).

## 2. Dati

Importi sempre in **centesimi** (numeri interi). Date di soggiorno come `AAAA-MM-GG`, sempre riferite all'Italia (Europe/Rome).

Tabelle principali:
- `houses`: le case (nome, colori, orari di check-in/out, ospiti massimi).
- `users`: chi può entrare (email, nome, ruolo `admin` o `collaboratore`, attivo).
- `bookings`: le prenotazioni (casa, canale, ospite, date, persone, importi, cauzione, lenzuola/asciugamani, delega minorenni, fase, passaggi di check-in e check-out, `version`).
- `booking_notes`: note veloci della prenotazione.
- `tasks`: cose da fare (casa, prenotazione, scadenza, assegnato a, fatto).
- `audit_log`: registro modifiche (chi, quando, cosa, campi cambiati).
- `ops`: operazioni già eseguite, per non ripeterle due volte.
- `meta`: contatore globale delle modifiche (`rev`).

## 3. Salvataggi affidabili (le cause dei bug del vecchio gestionale, risolte una per una)

1. **Il server è l'unica fonte di verità.** Ogni modifica è valida solo quando il server risponde "salvato".
2. **Versione su ogni record.** Ogni modifica invia la versione che l'utente stava guardando. Se nel frattempo un altro dispositivo l'ha cambiata, il server rifiuta (`409`) e l'app lo dice chiaramente invece di sovrascrivere.
3. **Operazioni ripetibili.** Ogni modifica ha un codice unico generato dall'app (`opId`). Se la rete cade e l'app ripete l'invio, il server riconosce il codice e non la esegue due volte.
4. **Tutto o niente.** Una modifica, la sua riga nel registro e l'aggiornamento del contatore vengono scritti insieme in un'unica transazione (`batch` di D1).
5. **Ordine garantito.** Ogni scrittura aumenta il contatore globale `rev`. L'app accetta un aggiornamento solo se il suo `rev` è più nuovo di quello che ha: una risposta vecchia non sovrascrive mai una nuova.
6. **La schermata non si azzera mai.** L'aggiornamento dei dati (al ritorno sull'app, ogni 30 secondi mentre è aperta, dopo ogni salvataggio) aggiorna solo i dati; moduli aperti, sezione e scorrimento restano dove sono. Se il record che stai modificando è cambiato altrove, compare un avviso.
7. **Errori sempre visibili.** Indicatore fisso: "Salvato", "Salvataggio…", "Errore — riprova". Un errore non sparisce da solo.
8. **Annulla esplicito.** Dopo ogni azione compare per pochi secondi "Annulla", che invia l'operazione inversa. Il sistema non annulla mai niente da solo.
9. **Nessuna copia vecchia dell'app.** Nella beta non c'è service worker: i file dell'app vengono sempre ricontrollati (`Cache-Control: no-cache`) e le risposte delle API non vengono mai salvate (`no-store`). Se sul server c'è una versione più nuova, compare "Aggiorna". Il service worker arriverà con le notifiche, solo per i file dell'app.
10. **L'indicatore si aggiorna da solo.** I controlli periodici aggiornano solo l'indicatore di salvataggio; la pagina si ridisegna solo quando i dati cambiano davvero, e mai mentre si scrive nei campi della procedura guidata.

## 4. Sicurezza

- Accesso: Cloudflare Access (codice via email o accesso con account) + verifica del token nel Worker (firma RS256, destinatario, scadenza) + email presente e attiva in `users`. Nessuna registrazione pubblica possibile.
- Ruoli: `admin` (Mattia) modifica impostazioni, utenti e case; `collaboratore` tutto il resto.
- Le API accettano solo richieste dello stesso sito (`Origin` controllato, JSON obbligatorio) e rispondono con `Cache-Control: no-store`.
- Intestazioni su tutto: CSP restrittiva senza script inline (`script-src 'self'`, Trusted Types), `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy: no-referrer`, Permissions-Policy, COOP/CORP, `X-Robots-Tag: noindex`.
- L'app non usa mai `innerHTML`: tutto il testo entra come testo, quindi un nome ospite non può diventare codice.
- Modalità sviluppo (`AUTH_MODE=dev`) consentita solo su `localhost`.
- Beta: solo dati inventati.

## 5. Ambienti e pubblicazione

- Codice in archivio GitHub privato.
- Cloudflare collegato all'archivio: ogni modifica approvata viene pubblicata da sola. Le modifiche alla struttura del database (`migrations/`) si applicano prima della pubblicazione del codice.
- Due ambienti: **prova** (dati inventati) e, quando la beta sarà approvata, **produzione** (dati veri), con database separati.
- Ritorno alla versione precedente: dal pannello Cloudflare (Deployments → Rollback). Database: Time Travel di D1 per tornare a un momento precedente.

## 6. Cosa c'è nella beta 0.1

- Oggi: le due case (soggiorno in corso o prossimo, etichette di stato, prossimo passo), avvisi, cose da fare.
- Prenotazioni: interruttore della casa, archivio per stagione, elenco per fase, calendario mensile, nuova prenotazione con controllo date sovrapposte, scheda con check-in e check-out guidati, note, cauzione, storico modifiche, annullamento.
- Impostazioni (solo admin): utenti e case.

Rimandati alle versioni successive: collegamento iCal con Airbnb/Booking, importazione da screenshot con l'AI, preventivi, contratto digitale, check-in online, Alloggiati/ISTAT, contabilità, analisi di mercato.
