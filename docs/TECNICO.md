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
- **Grassetto** come nel Word di Mattia: nel testo si scrive `**così**` (helper `bold`), il PDF e la finestra lo mostrano in grassetto; gli asterischi scritti a mano vengono tolti da `cleanText`.
- **Contratto in inglese** (`public/shared/contract-en.js`, `migrations/0010_contratto_inglese.sql`): nella finestra di firma si sceglie "Italiano" o "English". Stesse clausole, articolo per articolo (un test controlla che la struttura dei blocchi sia identica): se si cambia una clausola va cambiata in tutti e due i file. Testi della casa in inglese facoltativi in Impostazioni (descrizione, orari di silenzio, regole); se mancano si usa l'italiano. Colonna `contracts.lang`; la lingua entra nell'impronta quando non è l'italiano. PDF con scritte fisse in inglese ("THE LANDLORD", "Page x of y", "SHA-256 fingerprint"). Mattia ha confermato: frase su arrivo posticipato/partenza anticipata da tenere, conservazione 2 anni.

## Novità della 0.8 (14 novembre 2026): preventivi

- Nuova sezione **Preventivo** (`public/js/views/quote.js`, regole in `public/shared/quote.js`), per la casa scelta in alto. Il preventivo NON si salva (scelta di Mattia): la bozza resta in memoria finché l'app è aperta, niente nomi o telefoni sul dispositivo o nel database.
- **Prezzo consigliato** = media a notte dei soggiorni degli anni precedenti nello stesso periodo (date ± `window_days`, 7: i prezzi cambiano di settimana in settimana), pesata sulle notti nel periodo; solo soggiorni conclusi, non cancellati, con il prezzo. Correzioni automatiche: soggiorno lungo (da 7 notti −5%, da 14 −10%), richiesta molto anticipata (da 120 giorni +5%), ultimo minuto (entro 14 giorni −10%). Arrotondato a 10 €. Niente listino (Mattia cambia spesso i prezzi). Senza storico: prezzo a mano.
- **Controlli sulle date**: occupate, troppe persone, sotto il minimo di notti del mese (luglio e agosto 5, solo avviso), 1–2 notti scoperte prima o dopo.
- **Messaggio WhatsApp** in italiano o inglese, dal modello del vecchio messaggio di Mattia: date, notti, ospiti, prezzo; incluso (lenzuola/asciugamani, acqua, luce fino a N kWh dai "Dati del contratto", pulizie); a parte (tassa di soggiorno calcolata, extra, cauzione); acconto 30% arrotondato a 50 € non rimborsabile; saldo all'arrivo; orari; validità (7 giorni); link al sito della casa ("più foto e altre informazioni", `site_url` in Impostazioni, migrazione 0012); "Resto a disposizione per qualsiasi dubbio". Il saldo all'arrivo mostra le voci e il totale. Modificabile a mano prima dell'invio; "Invia su WhatsApp" apre wa.me (con o senza numero), "Copia il testo".
- **Impostazioni → Case → Preventivi** (`houses.quote_settings`, migrazione 0011): validità, cauzione proposta, notti minime per mese, correzioni, extra (garage 10 € a persona in tutte e due le case), nota finale. Solo l'amministratore.
- Ai collaboratori arriva `contract_public` (comune, kWh compresi, prezzo, acconto %), mai i dati del locatore.
- Dati di prova: 36 soggiorni estivi degli ultimi due anni per vedere il consiglio.
- **Calendari**: tutte le date si scelgono con lo stesso calendario delle prenotazioni (stile Airbnb). Periodo: `dateRangeField` (nel Preventivo, con le notti occupate barrate; in spazi stretti un mese solo, con una container query). Data singola: `dateField` in `public/js/pickers.js` (campo gg/mm/aaaa + calendario), usato in Archivio (spese e scadenze) e nelle cose da fare di Oggi. Date di nascita (contratto, locatore): solo campo gg/mm/aaaa, senza calendario.

## Novità della 0.9 (14 novembre 2026): contatore della luce e importazione da Excel

- **Contatore della luce** (`public/shared/meter.js`, `public/js/views/meter.js`, migrazione 0013): passaggio "Contatore della luce" nel check-in (arrivo) e nel check-out (partenza). Il display mostra tre fasce A1, A2, A3: si scrivono a mano, il totale si calcola da solo. Si salvano le fasce (`meter_start_bands`/`meter_end_bands`, JSON) e il totale (`meter_start`/`meter_end`) in decimi di kWh, con data e ora. Operazione `booking.meter` (`bands: [a1, a2, a3]` o null); spunta da sola il passaggio. Conti con i kWh compresi al giorno dei "Dati del contratto": nelle dirette l'extra "Luce" (nuovo tipo `luce` in `booking_extras`) si mette, aggiorna o toglie da solo; con Airbnb e Booking solo se lo si sceglie (extra "altro"). Messaggio per l'ospite con le tre fasce e il totale (italiano o inglese): "Salva e copia il messaggio" (appunti) o "Salva e apri WhatsApp". Niente foto (Mattia scrive i numeri). Il gas non c'è.
- **Importazione da Excel/CSV** — PRONTA MA NASCOSTA (`IMPORT_VISIBLE = false` in settings.js): Mattia non è convinto, manderà la vista di un bilancio (14/11). (`public/js/xlsx.js`, `public/shared/importer.js`, `public/js/views/import.js`; Impostazioni → Gestionale → "Importa da Excel", solo amministratore): il file si legge sul dispositivo (lettore .xlsx scritto a mano: zip + XML, con limiti contro i file troppo grandi; CSV con ; , o tab). Si scelgono le colonne (proposte dai nomi delle intestazioni), casa e canale dalla colonna o fissi, nomi e telefoni solo se si vuole (di base no). Anteprima con righe pronte, doppioni e problemi. Operazione `booking.import` (100 righe per volta, tutto in una transazione con registro e codice operazione): soggiorni finiti → "chiusa", in corso → "in_casa", futuri → "confermata"; date già occupate saltate; persone fino a 50 per lo storico.

## Novità della 0.10 (21 novembre 2026): contabilità

Regole decise con Mattia: `claude/gestionale-contabilita.md` nel progetto. Calcoli in `public/shared/accounting.js` (usato da app, server e test), pagina in `public/js/views/accounting.js`, migrazione 0014.

- **Prezzo del soggiorno** = quello pagato dall'ospite per il soggiorno, senza tassa di soggiorno né extra chiesti a parte (scritto sotto il campo del modulo).
- **Commissioni**: percentuale fissa per canale con la data da cui vale (`houses.accounting`, JSON: `channels.airbnb/booking[] = { from, pct_bp, vat, withheld }`, `cedolare_bp`, `goals { anno: centesimi }`). Di partenza: Airbnb 3% + IVA, dal 13/10/2026 15,5% + IVA, dal 2027 con ritenuta trattenuta; Booking 16,16% complessivo con ritenuta trattenuta. Conta la data di arrivo. Si cambiano in Impostazioni → Case → Contabilità (solo amministratore).
- **Cedolare** (21%) solo sul prezzo; trattenuta dal portale se `withheld`, altrimenti "da versare". **Extra a parte**: ricavo pieno, senza commissione né cedolare. **Cauzione trattenuta**: ricavo (il danno vero tra le spese, nuovo tipo "Danni"). **Tassa di soggiorno**: mai nei ricavi; si incassa e si versa (riquadro a parte).
- **Utile** = ricavi netti (prezzo − commissione + extra + cauzioni trattenute) − spese dell'anno (anno = inizio del periodo, altrimenti data) − cedolare.
- **Pagina Contabilità** (nuova voce del menu, la vedono tutti): casa e anno; 4 riquadri (ricavi netti, spese, cedolare, utile; in euro interi, confronto con l'anno prima, spiegazione al tocco); obiettivo annuo di utile con barra (lo imposta l'amministratore); "Da sistemare" (saldi, extra, pagamenti dei portali non segnati o diversi dal calcolato di oltre 1 €, costi da pagare, cedolare e tassa da versare); grafico "Dove vanno i soldi" (barra degli incassati divisa in commissioni #2F7FC1, spese #D9782F, cedolare #7C5CC4, utile #1E9E63) e "Da dove arrivano" (per canale: diretto #4CAF7A, Airbnb #B0306E, Booking #3366CC), con etichette, importi e percentuali (colori controllati con lo script dataviz); riquadri colorati; spese per tipo; (il "ricavo per notte" è stato tolto su richiesta di Mattia); soggiorni con il margine (basso se < 40% del prezzo); tassa di soggiorno, cauzioni, versamenti.
- **Scheda della prenotazione**: pannello "Conto del soggiorno" (conto completo, bonifico o contanti per acconto e saldo, "Pagamento ricevuto" per Airbnb e Booking, costi del soggiorno con "Aggiungi costi del soggiorno", proposto anche nel check-out). Ogni extra incassato chiede bonifico o contanti (`booking_extras.paid_method`).
- **Operazioni nuove**: `booking.money` (deposit_method, balance_method, payout_cents/payout_at solo per i portali), `remittance.add/delete/restore` (tabella `remittances`: tassa di soggiorno o cedolare, anno, importo, data).
- **File per il commercialista**: un .xlsx per casa e anno, creato sul dispositivo (`public/js/xlsx-write.js`, zip senza compressione): fogli Riepilogo, Soggiorni, Spese, Versamenti.
- Niente scadenze della cedolare (scelta di Mattia). Importazione del 2026 completo: quando Mattia manda il file.
- Barra in basso del telefono con 6 voci: sotto i 390 px le voci lunghe si accorciano (Prenot., Prevent., Contab., Impost.). `.grid-2` non sfora più sui telefoni da 320 px.

## Novità della 0.11 (22 novembre 2026): ospiti, Alloggiati Web e DMS Puglia

Migrazione 0015. Server: `src/guests.js` (ospiti), `src/questura.js` (credenziali, invio, ricevute), `src/alloggiati-ws.js` (servizio web della Polizia), `src/dms.js` (file del DMS), `src/secrets.js` (cifratura). Regole condivise: `public/shared/alloggiati.js`. App: `public/js/views/guests.js` (scheda) e `public/js/views/questura.js` (impostazioni e archivio).

- **Ospiti** (`guests`): cognome, nome, sesso, nascita (data e luogo), cittadinanza, residenza; per il capo anche il documento (tipo, numero, luogo di rilascio). I luoghi sono codici delle tabelle ufficiali di Alloggiati (`places`: comuni "C" e stati "S"; `doc_types`), scaricate dal servizio web con la prima prova di collegamento e aggiornate ogni 30 giorni. Gli ospiti NON sono nello stato dell'app: si leggono con `GET /api/bookings/:id/guests` e si salvano con `POST /api/guests` (operazioni `guest.save`, `guest.delete`, `guest.leader`, `booking.guest_group`), mai dalla coda offline (`/api/ops` le rifiuta: `PRIVATE_OPS`). Nel registro solo i nomi dei campi. Sulla prenotazione: `guests_entered`, `guests_done`, `guest_group` (famiglia/gruppo).
- **Alloggiati Web**: servizio web ufficiale SOAP (`https://alloggiatiweb.poliziadistato.it/service/service.asmx`, manuale WS_ALLOGGIATI rev. 01): GenerateToken → Test → Send; Ricevuta (PDF, ultimi 30 giorni, oggi escluso); Tabella (Luoghi, Tipi_Documento). Schedina = 168 caratteri (tabella 1 del manuale), nomi in maiuscolo senza accenti, tipi 16/17/18/19/20, capo per primo. Invio solo il giorno dell'arrivo o quello dopo (regola del portale). Prima `Test`: se anche una schedina è sbagliata non si invia niente. Blocco contro doppio invio (`alloggiati_error = 'IN_CORSO:…'` per 2 minuti) e conferma esplicita per reinviare. Riuscito → `alloggiati_at`, passaggio `alloggiati` spuntato.
- **Credenziali**: utente, password e WsKey per casa in `house_secrets`, cifrate AES-GCM con chiave derivata (HKDF) dal segreto Cloudflare **`CHIAVE_CREDENZIALI`** (almeno 32 caratteri) e legate alla casa. Mai nello stato, nella copia dei dati o nei log; si salvano/rimuovono solo dall'amministratore (`POST /api/alloggiati/credentials`), si provano con `POST /api/alloggiati/check` (Authentication_Test, nessuna schedina inviata). Stato senza segreti in `houses.alloggiati_status`. Per crearlo: Workers e Pages → digihome (o digihome-prova) → Impostazioni → Variabili e segreti → Segreto `CHIAVE_CREDENZIALI`. L'app genera una chiave casuale sul dispositivo da incollare.
- **Ricevute** (`alloggiati_receipts`, PDF in BLOB): lavoro automatico alle 7, 13 e 19 (ora italiana) per i giorni di invio degli ultimi 30 giorni; avviso nello stato della casa dopo 25 giorni senza ricevuta; si cancellano dopo 5 anni. Appena c'è la ricevuta si cancellano i dati dei documenti di quel giorno. Ospiti cancellati un anno dopo la partenza. Scaricabili da scheda e Archivio → Questura e DMS (`GET /api/receipts/:id`); a mano con `POST /api/alloggiati/receipt`.
- **DMS Puglia**: niente servizio web (SPID). `GET /api/dms?house&from&to` prepara l'XML per SPOT Online «Carica movimentazione» (movimentogiornaliero-0.6.xsd): un `<movimento>` per ogni giorno (MP con arrivi/partenze, NM altrimenti), `datistruttura` da `houses.dms_settings` (camere, posti letto), arrivi con codice interno (`guests.code`), sesso, cittadinanza, residenza (comune o stato), età, tipo 16/17/18 e componenti; partenza = codice del capo. Nessun nome o documento. `house.dms` salva camere/posti letto (amministratore) o "caricato fino al" (tutti): in quel caso il passaggio `dms` degli arrivi del periodo si spunta da solo. Il primo file deve iniziare con la casa vuota.
- **Da verificare con le credenziali vere** (prima del primo invio reale): che il portale accetti le chiamate da Cloudflare (pulsante "Prova collegamento") e che SPOT Online accetti il file (valori `si/no` minuscoli come nell'esempio delle specifiche; partenza indicata con il codice del capo).
- Server locale: il portale Alloggiati è simulato (password "sbagliata" per provare l'errore) e la chiave è fissa.
- Sui telefoni le finestre larghe ora occupano tutto lo schermo.
- 0.11.1: trascrizione fedele. Sulla schedina i nomi vanno solo in maiuscolo e senza accenti (À → A, ß → SS, Ø → O, Æ → AE); caratteri di altri alfabeti o simboli NON si tolgono in silenzio: il server rifiuta il salvataggio ("scrivilo in lettere latine, come sul passaporto"). Numero del documento: solo lettere e numeri (spazi e trattini tolti, altri simboli rifiutati). La finestra dell'ospite mostra in tempo reale "Sulla schedina: …" e la conferma d'invio elenca i nomi come verranno trasmessi. Test: ogni campo della schedina si rilegge uguale ai dati salvati.

## Novità della 0.12 (23 novembre 2026): modulo online per gli ospiti

Migrazione 0016. Logica: `src/guest-form.js`; Worker pubblico: `src/public-guests.js` con le pagine in `public-ospiti/` (italiano/inglese, nessuna libreria). Configurazioni: `ospiti/wrangler.jsonc` (definitiva, Worker `digihome-ospiti`, database digihome-ue) e `ospiti-prova/wrangler.jsonc` (prova, `digihome-ospiti-prova`, database digihome-prova).

- Nella scheda (Ospiti e Questura → Modulo online per l'ospite): "Crea il link per l'ospite" (operazione `booking.guest_link`, anche `renew` e `revoke`), poi WhatsApp in italiano o in inglese con il messaggio pronto, oppure "Copia il messaggio".
- Link corto: `<indirizzo>/<codice di 12 caratteri>` (alfabeto di 58 simboli senza 0/O/l/I, circa 70 bit). Indirizzo per casa dalla variabile `OSPITI_DOMINI` (JSON casa → https://…, es. `registrazione.faroblugallipoli.it`), altrimenti `OSPITI_PUBLIC_URL`.
- La pagina mostra solo casa, date e numero di ospiti; colore della casa. L'ospite compila tutti (luoghi con ricerca nelle tabelle ufficiali, stati anche in inglese), informativa privacy con il titolare (nome del locatore del contratto) e conferma. Tutti i campi obbligatori; stessi controlli del gestionale (`cleanGuest`, lettere latine) + luoghi esistenti e cittadinanza = stato.
- Ogni invio sostituisce del tutto gli ospiti della prenotazione (i vecchi dati si cancellano davvero), segna `guest_form_at` e i conteggi. Massimo 20 invii per link. Il link vale finché le schedine non sono inviate e al massimo fino al giorno dopo l'arrivo; prenotazione cancellata = chiuso.
- Worker pubblico: solo `GET /<codice>`, `GET /api/form/<codice>`, `GET /api/form/<codice>/places`, `POST /api/form/<codice>` (JSON, stessa origine, massimo 64 KB) e i file statici; intestazioni di sicurezza come il gestionale (CSP senza inline, Trusted Types, frame-ancestors none, noindex). Non restituisce mai dati già salvati.
- Server locale: il modulo risponde sulla porta successiva (8788).
- **Da attivare alla fine (collegamenti)**: creare in Cloudflare i Worker `digihome-ospiti-prova` (ramo main, cartella ospiti-prova/) e `digihome-ospiti` (ramo produzione, cartella ospiti/) con Workers Builds; collegare i domini personalizzati `registrazione.faroblugallipoli.it` e `registrazione.isolabellagallipoli.it` al Worker definitivo; aggiungere `OSPITI_DOMINI` in `produzione/wrangler.jsonc`.
- Sui telefoni: anche le eliminazioni di un ospite cancellano i suoi dati (resta solo la riga per il registro).

## Novità della 0.13 (23 novembre 2026): modulo da più telefoni

Migrazione 0017 (`guests.form_part`, `bookings.guest_form_leader_part`).

- Lo stesso link si può girare a tutto il gruppo: ognuno inserisce i suoi dati (ed eventualmente quelli di chi viaggia con lui) dal proprio telefono, oppure una persona li inserisce per tutti.
- Ogni telefono ha un codice casuale ("parte", 24 caratteri) salvato solo nel suo browser (`localStorage`, chiave `digihome-modulo-<codice del link>`; nessun dato personale). Gli invii di una parte sostituiscono solo i suoi dati precedenti; quelli degli altri telefoni restano.
- Prima domanda: "Ho prenotato io" / "Sono un altro ospite". Il documento serve solo a chi ha prenotato (primo ospite della sua parte); il tipo di gruppo (famiglia/amici) lo sceglie solo lui. Un solo telefono può essere "chi ha prenotato": il segno è atomico nella WHERE dell'invio (`leader_taken`, 409); gli altri vedono il pulsante disattivato.
- Ordine degli ospiti dopo ogni invio: parte di chi ha prenotato (capo), poi quelli inseriti nel gestionale, poi gli altri telefoni in ordine di primo invio (chi corregge mantiene il suo posto).
- `GET /api/form/<codice>?part=…` restituisce anche `entered` (ospiti già inseriti), `mine` (quanti da questo telefono), `leaderTaken`, `iAmLeader`. Mai i dati già salvati.
- Limiti: in tutto al massimo gli ospiti prenotati + 4 (massimo 30); 40 invii per link.
- Il messaggio WhatsApp dice che il link si può girare agli altri ospiti.

## Novità della 0.14 (23 novembre 2026): listino prezzi

Migrazione 0018 (`houses.pricing`, tabella `price_lists`, `bookings.booked_on`). Logica: `public/shared/pricing.js`; pagina: `public/js/views/pricing.js` (Preventivo → scheda "Listino prezzi", `#/preventivo/listino`).

- Scelte di Mattia: stagione giugno–settembre, prezzi diversi ogni settimana, prenotazioni da gennaio a maggio. Per ogni settimana si scrive il **netto in tasca**; il gestionale calcola il prezzo a notte da mettere in diretta, su Airbnb e su Booking: `prezzo = netto / (1 − commissione con IVA − cedolare)`, arrotondato all'euro in su (in tasca mai meno del netto scelto). Commissioni e cedolare sono quelle della Contabilità (regola valida nella data della settimana). Con uno sconto attivo sul portale (Genius ecc., in Impostazioni → Case → Listino) il prezzo da inserire è diviso per (1 − sconto).
- Niente stati delle settimane né spunte "aggiornato sul portale" (richiesta di Mattia): solo la base per decidere.
- Per ogni settimana: netto della stessa settimana dell'anno scorso e di due anni fa (52 settimane prima, stesso giorno; media sulle notti vendute riportata a 7 notti, con le commissioni valide allora), differenza in %, prezzi per canale.
- Ritmo delle prenotazioni (per mese della stagione): notti vendute oggi in % contro le notti che alla stessa data dell'anno scorso erano già prenotate (`booked_on`, oppure il giorno di inserimento se prima dell'arrivo; le prenotazioni importate dopo il soggiorno non sono confrontabili). Avanti/in linea/indietro con la soglia in punti delle impostazioni.
- Suggerimenti (mai applicati da soli; pulsante "Usa questo"): solo per settimane future senza notti vendute. Manca il prezzo → quello dell'anno scorso; oltre `hold_days` (90) dall'arrivo niente sconti; ultimo minuto a scaglioni (45/30/14 giorni: −5/−10/−15%); mese più lento −5% (solo vicino all'arrivo), più veloce +5%; mai sotto il netto minimo; arrotondati a 10 €.
- Strumenti veloci: "Copia l'anno scorso" (+%; dal listino dell'anno prima, altrimenti dall'incassato, altrimenti due anni fa; solo settimane vuote salvo scelta) e "Correggi un periodo" (mese o stagione, ±%).
- Operazione `price.set` (solo amministratore): unisce `{ settimana: centesimi | null }` al listino di casa e anno (riga `price_lists` con id `casa:anno`), riprova se due dispositivi scrivono insieme. Tutti vedono il listino (`prices` nello stato).
- Preventivo: se tutte le notti sono nel listino, il prezzo proposto è quello del listino (diretto); lo storico resta come confronto.
- Oggi: il lunedì, da gennaio ad agosto, per l'amministratore, "Lunedì dei prezzi: N settimane da valutare".
- `booked_on`: si segna alla creazione (gestionale e calendari) e all'importazione se il file ha la colonna "Data della prenotazione".
- 0.14.1: nella scheda "Copia solo il link" (oltre a "Copia il messaggio"); nella definitiva il modulo ospiti resta spento (niente `OSPITI_PUBLIC_URL` in produzione/wrangler.jsonc) finché il Worker `digihome-ospiti` non è creato e collegato ai domini: così non si possono creare link che non funzionano.
- 0.14.2: Archivio → Spese, riepilogo dell'anno rifatto (totale in evidenza, una barra per tipo di spesa dalla più alta, con margini interni).
- Nome scelto da Mattia (23/11) per i link del modulo: `registrazione.faroblugallipoli.it` e `registrazione.isolabellagallipoli.it` (sottodomini dei siti, da collegare al Worker `digihome-ospiti` nei collegamenti finali).

## 0.14.3 (23 novembre 2026): giro di semplificazione
- Impostazioni: la sezione "Case" viene per prima e, per ogni casa, al posto di sette pulsanti uguali c'è un elenco di voci (Casa, Dati del contratto, Preventivi, Listino, Contabilità, Alloggiati Web, DMS Puglia) con il riassunto di quello che è impostato e, in arancione, cosa manca. Ogni voce apre la stessa finestra di prima. Poi calendari e utenti.
- Scheda della prenotazione: "Contatti" e "Dettagli" uniti in una sola scheda.
- Contabilità: la scelta dell'anno non si allarga più su tutta la riga.
- Controllate tutte le schermate su iPad e telefono: nessun errore. L'avviso rosso in cima a Oggi per il check-in in ritardo resta anche se la scheda della casa lo mostra (sul telefono la scheda può essere fuori schermo).

## Novità della 0.15 (23 novembre 2026): ricevuta del saldo

Migrazione 0019 (`houses.receipts_enabled`, tabella `pay_receipts`). Testo: `public/shared/receipt.js`; PDF: `buildReceiptPdf` in `public/js/pdf.js`.

- Facoltativa per casa (Impostazioni → Case → Casa → "Ricevuta del saldo"), spenta di partenza. Solo prenotazioni dirette, solo l'amministratore (contiene i dati del locatore).
- Scelte di Mattia: solo l'importo del **saldo all'arrivo** (`balanceDue`), in italiano e in inglese, **nessun riferimento alla marca da bollo** (né frase né riquadro: richiesta di Mattia, 0.15.1).
- Operazione `payreceipt.issue`: una ricevuta per prenotazione, numero progressivo per casa e anno (data di oggi) assegnato nella stessa istruzione che la salva (`UNIQUE(house_id, year, number)`, si riprova in caso di scontro). `data` conserva il testo (locatore, CF facoltativo dai Dati del contratto, immobile, CIN, ospite, date, modo di pagamento): si riscarica identica. Se dopo il saldo cambia, la scheda lo segnala.
- Dicitura (da confermare con il commercialista): "Operazione fuori campo IVA. Locatore persona fisica in regime di cedolare secca."
- Dati del contratto: nuovo campo facoltativo "Codice fiscale" del locatore (controllato), usato solo nella ricevuta.
- Giro di semplificazione (0.14.3) già in definitiva.
- 0.15.2: colori "Carta calda" (scelta di Mattia: lo schermo stancava). Sfondo #E9E5DD, schede #F6F3ED, campi #FBF9F5, testo #2B2824, secondario #645E54 (contrasti 13:1 e ≥ 4,8:1). Niente bianco puro né nero pieno; colori delle case invariati. Il modulo per gli ospiti non cambia.

## Novità della 0.16 (23 novembre 2026): grafica
- Avvisi con un'icona per tipo (`alertIcon` in ui.js): soldi, Questura/check-in (scudo), orari e scadenze (orologio), telefono, dati degli ospiti, calendari, partenza. Il colore resta quello dell'urgenza. Anche in Contabilità e nella scheda.
- Oggi: "Prossimi 7 giorni" con arrivi, partenze e cambi per casa (iPad: una colonna per giorno; telefono: solo i giorni con movimenti). DA CONFERMARE da Mattia (voleva vederla prima).
- Calendario delle prenotazioni con i colori dei canali (diretto verde, Airbnb rosa, Booking blu, come in Contabilità) e legenda.
- Testo più grande su iPad e computer (≥ 761 px): corpo 17 px, interlinea 1,55; il telefono resta com'era.
- Nuova icona dell'app e logo: casa piena con sfumatura verde Isola Bella → blu Faro Blu e "DG" in color carta (`public/icons/`: icon.svg, logo.svg, apple-touch-icon.png, icon-192/512.png, icon-maskable-512.png). Logo anche nella barra laterale.
- 0.16.1: icona definitiva = opzione A scelta da Mattia (fondo con sfumatura verde → blu, casa a contorno color carta, "DG" centrato in orizzontale e otticamente in verticale nella casa). "Prossimi 7 giorni" confermata e spostata sopra le schede delle case; tolto "· tutte e due le case" sotto la data di Oggi.

## Novità della 0.17 (23 novembre 2026): mercato con Apify

Migrazione 0020 (`houses.market_settings`, tabelle `market_comps`, `market_prices`, `market_jobs`). Regole: `public/shared/market.js`; lavori su Apify: `src/market.js`; interfaccia: `public/js/views/market.js` (finestra Impostazioni → Case → Mercato, scheda "Mercato" del listino), più colonna nel listino e riga nel preventivo.

- Scelte di Mattia: tutte e due le case, separate; 10 case simili per casa; confronto di prezzi, disponibilità, dotazioni (aria condizionata ecc.) e spese a parte; sintesi E consigli sui prezzi.
- Chiave: segreto Cloudflare `APIFY_TOKEN` (solo server, intestazione `Authorization: Bearer`, mai nel database, nei log o nello stato). L'app sa solo `apifyReady`.
- Attori Apify: `tri_angle~airbnb-scraper` (ricerca: luogo, ospiti, camere minime; in inglese, EUR) e `tri_angle~airbnb-rooms-urls-scraper` (per ogni settimana: le 10 case scelte con checkIn/checkOut). Senza prezzo = "non disponibile" (prenotata o chiusa).
- Ricerca → punteggio di somiglianza (distanza entro il raggio, ospiti, camere, dotazioni in comune, recensioni) → 15 candidate, le prime 10 scelte in automatico se non c'era una scelta (`market.select`, al massimo 10, solo amministratore).
- Prezzi: un lavoro per settimana futura della stagione del listino; in automatico una volta a settimana; al massimo 3 lavori insieme (memoria 1 GB, timeout 15 min), letti a ogni giro dell'orologio (30 min) o con "Controlla" dalla finestra; 2 tentativi. Costo stimato ~0,7 $ a settimana per le due case (5 $ gratuiti al mese, il piano gratuito si ferma da solo).
- Salvati solo dati pubblici: titolo, link, ospiti, camere, distanza, valutazione, numero di recensioni, dotazioni (chiavi nostre), prezzo per l'ospite di 7 notti senza tasse e costi del servizio (pulizie comprese) e pulizie a parte. Niente host, niente testo delle recensioni.
- Listino: riga "Mercato" per settimana (mediana delle libere · prenotate/controllate · tu rispetto a loro, confrontando il tuo prezzo Airbnb); consigli in "Da valutare" (≥ 70% prenotate e tu sotto → alza fino a +15%; ≤ 40% prenotate entro 60 giorni e tu sopra di oltre 10% → scendi fino a −15%; scarto oltre 20% → segnalazione); scheda "Mercato" con consigli sulle dotazioni e tabella "Dotazioni a confronto".
- Preventivo: "Mercato su Airbnb" con prezzo a notte delle case simili libere, prenotate su controllate, confronto con il prezzo diretto e un consiglio (tenere il prezzo pieno / margine per uno sconto).
- Server locale: Apify finto (40 annunci inventati intorno a Gallipoli, prezzi più alti e più occupazione ad agosto).
- 0.17.1: "Posti (ospiti)" tra i criteri della ricerca (richiesta di Mattia): la ricerca chiede ad Airbnb case con almeno posti − 1, si scartano quelle con più di 2 posti di differenza, e nel punteggio i posti pesano più delle camere. Vuoto = massimo di ospiti della casa.
- 0.17.2: le coordinate si possono incollare anche da Mappe di Apple ("40,0558° N, 17,9925° E").
- 0.17.4 (migrazione 0021, `market_comps.source`): Mattia può scegliere lui le case simili incollando il link di Airbnb (sito o app, `/rooms/<numero>`; `listingIdFromUrl` accetta solo domini airbnb.*). Operazioni `market.add` (scelta subito; se le 10 sono piene lascia il posto la meno simile tra quelle della ricerca; mette in coda il controllo della prima settimana, che porta titolo, posti, camere, distanza e dotazioni) e `market.remove` (toglie la casa e i suoi prezzi). Le case "scelte da te" restano anche rifacendo la ricerca. Mattia (23/11): "così inserisco io le 10 case".
- 0.17.5: conferma chiara nella finestra Mercato (richiesta di Mattia, 24/11: "altrimenti premo all'infinito"). Riquadro verde "Ricerca partita" / "Aggiornamento dei prezzi partito: X di N settimane pronte"; i pulsanti si spengono mentre il lavoro è in corso ("Ricerca in corso…", "Aggiornamento in corso…") e durante la richiesta ("Avvio…"). Sul server `requestRefresh` non rifà le settimane già controllate nelle ultime 12 ore dopo l'ultima modifica delle case scelte (`freshWeeks`: audit `mercato` e `found_at` delle scelte), e risponde `queued` / `already` / `fresh` per il messaggio. Le settimane già in coda non si duplicano (come prima).
- 0.17.6 (24/11): STORICO e LETTURA DEL CONTRATTO. (1) Una prenotazione nuova con partenza prima di oggi (`check_out < oggi`) si salva direttamente `chiusa`, solo dall'amministratore; niente orario, cauzione, acconto, delega e tassa di soggiorno nel modulo; campo facoltativo "Prenotata il" (`booked_on`, ≤ arrivo; senza resta vuoto, non oggi, per non falsare il ritmo). `enteredAfterStay(b)` (creata dopo la partenza, anche le importate): nessun pannello Ospiti e Questura, contratto, check-in/out da rivedere, etichetta "Storico"; in Contabilità niente "saldo non segnato"/"pagamento del portale non arrivato" e niente cedolare/tassa da versare per gli anni con solo storico. Chiusa: l'amministratore la può modificare (date sempre nel passato) e cancellare/ripristinare; il collaboratore no. (2) Contratto: finestra della firma più grande (1120 px), testo 17 px, pulsante "Leggi a schermo intero" (dialog `reader` a tutto schermo sopra la firma, caratteri 17–29 px con A−/A+ ricordati sul dispositivo in localStorage con try/catch, "Ho letto · torna alla firma"). 172 test.
- 0.18 (24/11 sera): DMS PUGLIA CON SPOT EASY. Le case di Mattia sono locazioni turistiche: usano SPOT Easy (non SPOT Online), che accetta solo la «scheda Alloggiati» (.txt, pulsante «Carica scheda Alloggiati», dopo aver scelto in Impostazioni l'uso «solo statistico»); la residenza si sceglie poi su SPOT Easy; trasmissione automatica la notte tra il 10 e l'11 del mese dopo. `GET /api/bookings/:id/spot` (`spotFile` in src/questura.js): le stesse righe da 168 caratteri inviate alla Questura, capo per primo, CR LF, ASCII; rifiutato se gli ospiti non sono completi o se il documento del capo è già stato cancellato dopo la ricevuta (allora la scheda mostra i dati per «Aggiungi un nuovo arrivo» a mano). Scheda della prenotazione → Ospiti e Questura → «DMS Puglia · SPOT Easy» (scarica, residenze da scegliere, «Fatto: caricato su SPOT Easy» = passaggio `dms` del check-in). Archivio → Questura e DMS: riepilogo degli arrivi del mese scorso e di questo (caricato / da caricare, scadenza). Tolti dall'interfaccia il file XML di SPOT Online e le impostazioni camere/posti letto (il codice del server `src/dms.js` resta, non usato). Nuovo test di sintassi di tutti i file JS (`test/syntax.test.js`). 174 test.
- 0.18.1: calendario di Booking — un evento di 28 notti o più è una chiusura (es. fuori stagione), non una prenotazione: si ignora (`CLOSURE_NIGHTS` in src/calendars.js). Booking esporta prenotazioni e chiusure allo stesso modo ("CLOSED - Not available").
- 0.18.2: Booking.com rifiutava il link del calendario ("URL iCal non valido") anche con un calendario corretto: il link ora è sul dominio della casa e contiene "ical" — `https://calendario.<sito>/ical/<codice>.ics` (routes custom_domain in calendario/wrangler.jsonc, `CALENDARI_DOMINI` in produzione/wrangler.jsonc → `info.calendarBases`). Il Worker risponde sia a /ical/ sia a /cal/ (i link già dati ad Airbnb restano validi).
