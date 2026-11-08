# DigiHome

Il gestionale di **Isola Bella** e **Faro Blu**: schermata Oggi, prenotazioni, check-in e check-out guidati, avvisi, cose da fare.
Beta 0.1, **solo dati inventati**.

- Documento tecnico: [`docs/TECNICO.md`](docs/TECNICO.md)
- Nessuna dipendenza esterna: HTML, CSS e JavaScript semplici, Cloudflare Worker + D1.

## Provarlo sul computer

Serve Node 22 o più recente.

```
node scripts/dev.js        # http://localhost:8787, con dati di prova
npm test                   # tutti i test automatici
```

Opzioni: `DELAY_MS=1500` simula una rete lenta, `AS=giulia@example.invalid` entra come collaboratore, `EMPTY=1` parte senza prenotazioni.

## Messa online su Cloudflare (ambiente di prova)

Da fare una volta sola, nel pannello Cloudflare.

1. **Database.** Storage e database → D1 → *Create* → nome `digihome-prova`. Il *Database ID* è già in `wrangler.jsonc`.
2. **Zero Trust.** Aprire Zero Trust e creare il team (piano gratuito). Annotare l'indirizzo del team, del tipo `https://NOME.cloudflareaccess.com`.
3. **Worker collegato a GitHub.** Workers e Pages → *Create* → *Import a repository* → questo archivio.
   - Comando di build: nessuno.
   - Comando di deploy: `npx wrangler d1 migrations apply digihome-prova --remote && npx wrangler deploy`
4. **Indirizzo.** Nel Worker: Impostazioni → Domini e route → *Add custom domain* → es. `gestione.faroblugallipoli.it`.
5. **Controllo di accesso.** Zero Trust → Access → Applications → *Add* → *Self-hosted*:
   - dominio: lo stesso del punto 4;
   - policy *Allow* con le email autorizzate;
   - metodo di accesso: *One-time PIN* (codice via email).
   - Copiare l'*Application Audience (AUD) Tag*.
6. **Segreti del Worker.** Impostazioni → Variabili e segreti → aggiungere come **Secret**:
   - `ACCESS_TEAM_DOMAIN` = indirizzo del team (punto 2)
   - `ACCESS_AUD` = AUD Tag (punto 5)
   - `BOOTSTRAP_ADMIN_EMAIL` = email dell'amministratore (diventa amministratore al primo accesso)
7. Aprire l'indirizzo, accedere con il codice ricevuto via email, poi **Impostazioni → Carica dati di prova**.

Senza i segreti del punto 6 il gestionale non lascia entrare nessuno (blocco di sicurezza voluto).

## Aggiungere un collaboratore

1. In Zero Trust, aggiungere la sua email alla policy dell'applicazione.
2. Nel gestionale, Impostazioni → *Aggiungi persona*.

Serve che l'email sia in **entrambi** gli elenchi.

## Tornare indietro

- Codice: pannello del Worker → Deployments → *Rollback* alla versione precedente.
- Database: D1 → Time Travel, per ripristinare un momento precedente.
