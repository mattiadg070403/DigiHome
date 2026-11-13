# DigiHome — documento tecnico

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

## Novità della 0.2 (8 novembre 2026)

- **Le finestre non si chiudono più toccando fuori.** Sull'iPad chiudere la tastiera o il selettore di date generava un tocco "fuori" che chiudeva il modulo (e sul computer il clic per tornare nella finestra). Ora si chiude solo con X, Annulla o Esc, e con dati non salvati chiede conferma.
- **Bozza sul dispositivo.** Il modulo della prenotazione si salva da solo mentre si scrive (localStorage, chiave `dh.bozza.prenotazione`), si riprende dopo ricarica o chiusura della scheda, si cancella al salvataggio e scade dopo 48 ore. Contiene i dati dell'ospite solo su quel dispositivo.
- **Calendario stile Airbnb** (`public/js/pickers.js`): primo tocco arrivo, secondo partenza; notti occupate barrate e non selezionabili; si può arrivare il giorno in cui parte un altro e partire il giorno in cui arriva il successivo. Date scrivibili anche a mano (gg/mm/aaaa, barre automatiche, passaggio automatico alla partenza), con controllo della partenza prima dell'arrivo.
- **Orario** con i due punti automatici e orari rapidi; **persone** con − e + e avviso immediato oltre il massimo della casa.
- **Promemoria per l'arrivo** (lenzuola, asciugamani, cosa incassare, delega, orario) nella scheda e come primo passaggio del check-in.
- **Avvisi con azione**: chiedere su WhatsApp con messaggio pronto, segnare come ricevuto, completare il dato mancante.

## Novità della 0.3 (8 novembre 2026)

- **Schedine Alloggiati e comunicazione DMS Puglia obbligatorie.** Sono due passaggi `required` del check-in (`alloggiati`, `dms` in `checkinSteps`): il server rifiuta "Concludi check-in" se mancano. Compaiono anche nel promemoria per l'arrivo, con l'orario limite.
- **Scadenza delle 24 ore** (`public/shared/booking.js`): arrivo = data di arrivo + orario previsto (o inizio check-in della casa); il check-in va concluso entro 24 ore. Funzioni `checkinDeadline`, `checkinOverdue`, `checkinMissing`. Nuove fasi: `checkin_corso` ("Check-in in corso") e `checkin_ritardo` ("Check-in in ritardo" / "Check-in incompleto"). Prima della scadenza: avviso di attenzione con l'orario limite e cosa manca; dopo: avviso urgente, riquadro rosso in cima a Oggi, prossimo passo rosso nella scheda della casa e banner nella procedura di check-in.
- L'app ricalcola ogni minuto (ora italiana, `timeRome`) e ridisegna appena una prenotazione supera la scadenza.
- Corretto il testo "null" che compariva accanto agli orari rapidi, sotto il calendario senza date e nei messaggi delle finestre (gli elementi condizionali passati a `append`/`replaceChildren` nativi).
- Notifica push con l'app chiusa: non ancora presente (serve Web Push con service worker e un controllo programmato sul server).

## Novità della 0.4 (10 novembre 2026)

- **Calendari di Airbnb e Booking** (`src/ical.js`, `src/calendars.js`, `migrations/0002_calendari.sql`).
  - Tabella `calendars`: una riga per casa e piattaforma, con il link iCal (`import_url`, solo sul server: l'app riceve `connected` e il sito, mai il link; non finisce nemmeno nel registro).
  - Il link è accettato solo `https` e solo da domini airbnb.* / booking.com (`public/shared/calendar.js`).
  - Lettura ogni 30 minuti (Cron Trigger in `wrangler.jsonc`) e con "Aggiorna ora" (`POST /api/calendars/sync`, al massimo una volta al minuto per calendario).
  - Download con tempo massimo 20 secondi e dimensione massima 3 MB.
- **Regole di importazione**
  - Airbnb: "Reserved" è una prenotazione; "Not available" è un blocco e si ignora (comprende le date arrivate da altri calendari).
  - Booking: ogni evento è una prenotazione, tranne quelli coperti per intero da prenotazioni di altri canali (copie). Si legge prima Airbnb, poi Booking.
  - Le prenotazioni passate si ignorano.
  - Prenotazione nuova: creata con `needs_details = 1` (nome provvisorio, 1 persona). Le ultime cifre del telefono di Airbnb non si salvano; il codice HM… e il link della prenotazione sì.
  - Se esiste già una prenotazione inserita a mano con stesso canale e stesse date, si collega quella (`ext_uid`).
  - Date cambiate: si aggiornano prima dell'arrivo; durante il soggiorno solo la partenza. Se Airbnb cambia il codice insieme alle date, si sposta la stessa prenotazione.
  - Prenotazione futura sparita da un calendario non vuoto: cancellata in automatico (`ext_gone = 1`), con avviso "Cancellata in automatico" e pulsanti "Ok, visto" / "Ripristina". Se ricompare, torna confermata.
  - Calendario arrivato vuoto: non si cancella niente, si segnala da verificare.
  - Ripristinata a mano o segnata "ancora valida": si stacca dal calendario (`ext_uid = NULL`), così non viene ricancellata.
  - Annullata a mano (es. "non è una prenotazione"): il calendario non la ricrea.
  - Le modifiche automatiche sono nel registro come "Calendario automatico".
- **Dati da completare.** Il modulo mostra l'avviso e nasconde il canale. Salvarlo azzera `needs_details`. Promemoria, avvisi ed elenchi mostrano "ospiti da completare".
- **Copia dei dati** (`GET /api/export`, solo amministratore): tutte le tabelle e il registro in un file JSON, senza i link dei calendari.
- **Versione definitiva**: `produzione/wrangler.jsonc` (Worker `digihome`, database `digihome`, `ALLOW_DEMO = false`, ramo `produzione`). Un test controlla che resti separata dalla prova.
- **Calendario pubblico per Airbnb e Booking** (`src/public-calendar.js`, `calendario/wrangler.jsonc`, `migrations/0003_calendario_pubblico.sql`).
  - Worker separato (`digihome-calendario`) senza Cloudflare Access, perché le piattaforme non possono fare il login. Cloudflare Access protegge tutto il Worker principale e non permette di aprire un solo percorso.
  - Risponde solo a `GET /cal/<48 caratteri esadecimali>.ics`; tutto il resto dà 404. Nessuna intestazione che permetta cache o indicizzazione.
  - Per ogni casa e piattaforma c'è un codice casuale di 192 bit (`calendars.export_token`), rigenerabile dall'amministratore.
  - Contenuto: solo date (UID `<id>@digihome`, "Non disponibile") delle prenotazioni non cancellate degli altri canali, dal giorno prima in poi.
  - Niente giri a vuoto: Airbnb rimanda le nostre date come "Not available", che si ignora; Booking le rimanda come date chiuse coperte da prenotazioni di altri canali, che si ignorano. C'è un test del giro completo.
  - Solo nella versione definitiva (`CALENDAR_PUBLIC_URL`); nella prova il dialogo lo spiega.

## Novità della 0.5 (10 novembre 2026)

- **Extra della prenotazione** (`migrations/0005_extra.sql`, tabella `booking_extras`): soldi a parte rispetto al soggiorno, per esempio la tassa di soggiorno degli ospiti Airbnb e Booking o un supplemento.
  - Ogni extra ha tipo (`tassa_soggiorno` | `altro`), descrizione, importo in centesimi, incassato sì/no con data, eliminazione reversibile e registro.
  - Operazioni: `extra.add`, `extra.update`, `extra.delete`, `extra.restore`.
  - Nella scheda: elenco, "Totale prenotazione" = soggiorno + extra, aiuto al calcolo della tassa (persone × notti × tariffa).
  - Gli extra da incassare compaiono nel promemoria, nel passaggio dei pagamenti del check-in e negli avvisi (urgente se l'ospite è già partito).
  - Pronti per la contabilità: una riga per voce, con tipo e data di incasso.
- **Contratto solo per le prenotazioni dirette**: il passaggio "Contratto firmato" non c'è più per Airbnb e Booking, anche nel controllo del server.
- **Cancellazione di una prenotazione Airbnb/Booking nel gestionale** (`migrations/0004_avviso_cancellazione.sql`, `ext_cancel_warn`).
  - Compare un avviso urgente: sulla piattaforma è ancora attiva. Pulsanti: "Fatto, cancellata anche su …", "Non era una prenotazione vera", "Ripristina".
  - L'avviso si toglie da solo quando la prenotazione sparisce anche dal calendario della piattaforma.
  - Finché non è confermata, le sue date restano bloccate sull'altra piattaforma (calendario pubblico).
  - Il messaggio di conferma spiega cosa succede per ogni canale.
- **Affidabilità dei salvataggi**
  - Coda delle modifiche copiata sul dispositivo (`dh.outbox`, massimo 72 ore): se l'app si chiude, si ricarica o la sessione scade, al riavvio le modifiche ripartono con lo stesso codice (nessun doppione).
  - Sessione scaduta riconosciuta (`redirect: 'manual'`): la modifica resta in attesa invece di essere scartata.
  - Nuovo tentativo automatico appena torna la rete. Avviso del browser se si chiude la pagina con modifiche in sospeso.
  - I record eliminati non "ricompaiono" per un attimo dopo la conferma.
- **Errori dell'app registrati sul server** (`POST /api/log`): solo id utente, messaggio, schermata e versione, nessun dato degli ospiti.
- **Sicurezza**
  - Le chiavi di Access si riscaricano al massimo una volta al minuto anche con token inventati.
  - Codice di prenotazione duplicato → 409 invece di errore del server.
  - Massimo 90 notti controllato anche sulle modifiche parziali.
- Sottotitolo del menu preso dai nomi delle case (niente nomi scritti nel codice).
- **Tassa di soggiorno nel modulo della prenotazione** (`public/shared/tax.js`, `migrations/0006_tassa_soggiorno.sql`).
  - Tariffe per casa e per mese, in centesimi a persona a notte (`houses.tourist_tax`), con eventuale limite di notti tassate. Si modificano in Impostazioni → Case → Modifica.
  - Valori di partenza: maggio e ottobre 0,50 €, da giugno a settembre 1 €.
  - Nel modulo: persone che pagano (segue il numero di ospiti finché non lo si cambia; si tolgono gli esenti), importo calcolato notte per notte con la tariffa del mese (modificabile a mano, con "Usa il calcolo"), "già incassata".
  - Salvata come extra `tassa_soggiorno` con `persons`: una sola per prenotazione. Importo 0 consentito (tutti esenti).
  - Avvisi: "Tassa di soggiorno non inserita" (da 7 giorni prima dell'arrivo) e "da ricontrollare" se date o persone non tornano più con l'importo salvato (non per gli importi scritti a mano).
  - Gli altri extra (garage, transfer…) restano nella scheda.

## Novità della 0.6 (11 novembre 2026)

- **Promemoria per l'arrivo con livelli** (`arrivalReminderItems`): i soldi da incassare sono sempre la prima voce, in verde e grassetto, con il totale. Gli obblighi (Alloggiati e DMS, delega minorenni, contratto per le dirette) sono in giallo; preparazione e informazioni in testo normale.
- **Archivio della casa** (`migrations/0007_casa.sql`, `public/shared/house.js`, `public/js/views/archive.js`, menu "Archivio"). Lo vedono e lo usano tutti, anche i collaboratori.
  - **Spese** (`expenses`): luce, acqua e condominio (insieme), TARI, pulizie, lavanderia, manutenzione, acquisti, altro. Niente gas (non c'è). La luce è stata aggiunta con `0008_spese_luce.sql`.
    - Campi: importo, data, periodo (per acqua/condominio e TARI), "da pagare entro" se non pagata, note.
    - Pulizie e lavanderia si possono legare a un soggiorno.
    - Solo dati, niente allegati: la colonna `attach_ref` è pronta per aggiungerli in futuro senza rifare la tabella.
    - Totali per anno e per tipo; elenco per mese; "Da pagare" in cima con il pulsante "Pagata".
  - **Scadenze** (`deadlines`): una volta sola, ogni mese, ogni 3 mesi, ogni anno, con preavviso in giorni.
    - "Fatta" chiude le uniche e sposta le ricorrenti alla data successiva (fine mese gestita), con "Annulla".
  - **Avvisi in Oggi**: scadenze entro il preavviso o passate; spese da pagare entro 7 giorni o scadute. Toccando l'avviso si apre la sezione e la casa giuste (`#/archivio/scadenze/<casa>`).
  - Operazioni: `expense.add/update/delete/restore`, `deadline.add/update/done/delete/restore`, tutte con versione, registro e annullamento. Comprese nella copia dei dati.
- Controllo di sicurezza delle parti nuove:
  - colonne SQL solo da elenchi chiusi; tabelle fisse nel codice;
  - casa e soggiorno verificati sul server (il soggiorno deve essere della stessa casa);
  - nessun innerHTML;
  - prove su iPad e telefono senza errori né scorrimento orizzontale.

## Novità della 0.7 (13 novembre 2026): contratto digitale

Solo per le prenotazioni dirette. L'ospite legge e firma sull'iPad; firma anche il locatore; il PDF si crea sul dispositivo e si invia dal menu Condividi (WhatsApp).

- **Dati** (`migrations/0009_contratto.sql`):
  - `houses.contract_info` (JSON): locatore, immobile, CIN, orari di silenzio, kWh compresi e prezzo, acconto %, contatto privacy, regole della casa. I dati personali del locatore NON sono nel codice: si scrivono in Impostazioni → Case → Dati del contratto. Ai collaboratori arriva solo `contract_ready` (sì/no), mai `contract_info`.
  - `houses.default_linens/default_towels`: biancheria proposta nelle nuove prenotazioni (Faro Blu lenzuola sì, asciugamani no; Isola Bella tutti e due).
  - `contracts`: testo firmato (blocchi JSON), dati dell'ospite, due firme JPEG (massimo 120 KB l'una), data e ora, impronta SHA-256, `purge_after`. Un solo contratto valido per prenotazione (indice unico parziale).
- **Modello del testo** (`public/shared/contract.js`, versione `CONTRACT_TEMPLATE = 1`): dal contratto di Mattia, con le sue modifiche: niente importo totale (rimando alla conferma scritta), solo dirette, nuovo articolo acconto (~30%) non rimborsabile e cancellazione, niente gas, biancheria secondo la prenotazione, tassa di soggiorno sempre a parte, cauzione dalla prenotazione o "non prevista", persone della prenotazione, articolo sulla firma elettronica, informativa privacy in calce. **Da far rivedere una volta a un legale o al commercialista.**
- **Firma** (`POST /api/contracts`, operazione `contract.sign`): solo in linea, non passa dalla coda delle modifiche (il testo firmato deve essere quello del server in quel momento). Il server ricontrolla tutto (dati dell'ospite maggiorenne, codice fiscale con carattere di controllo, documento, firme JPEG valide, conferma di lettura), ricrea il testo, calcola l'impronta e spunta il passaggio "Contratto firmato" del check-in nella stessa transazione. Limite di 400 KB solo per questo indirizzo; `/api/ops` resta a 64 KB e rifiuta `contract.sign`.
- **Lettura** (`GET /api/contracts/:id`): l'amministratore sempre; chi l'ha fatto firmare solo nelle 24 ore successive. Nello stato generale ci sono solo i metadati (mai testo, dati o firme). Testo da firmare: `GET /api/bookings/:id/contract-draft`.
- **Eliminazione** (`contract.delete`, solo amministratore): contenuto svuotato subito, passaggio del check-in tolto, riga cancellata dopo 30 giorni.
- **Conservazione**: 2 anni dopo la partenza (`KEEP_YEARS`), poi cancellazione automatica nel controllo programmato (`purgeContracts`), con riga nel registro "DigiHome (automatico)".
- **PDF** (`public/js/pdf.js`): scritto a mano, nessuna libreria; Helvetica WinAnsi (i testi si accettano solo in caratteri latini, le lettere con segni non stampabili diventano semplici), firme come immagini JPEG, nomi sotto le firme, impronta e numero di pagina in ogni pagina. Controllato con qpdf.
- **Interfaccia** (`public/js/views/contract.js`): passaggio "Contratto firmato" del check-in → finestra con dati dell'ospite, testo con la riga dell'ospite che si aggiorna, conferma di lettura, due riquadri di firma (dito o penna), "Firma e salva". Riquadro "Contratto" nella scheda. "Firmato su carta" come alternativa. Dati e firme non si salvano come bozza sul dispositivo; uscendo con dati scritti chiede conferma.
- Registro: "Contratto firmato sull'iPad", "Contratto eliminato", "Contratto cancellato (fine del periodo di conservazione)", senza dati personali.
