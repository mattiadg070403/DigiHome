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
4. **Indirizzo e controllo di accesso.** Beta: indirizzo gratuito `digihome-prova.<account>.workers.dev`.
   - Nel Worker: Impostazioni → Domini e route → riga *workers.dev* → attivare **Cloudflare Access**.
   - In Zero Trust → Access → Applications, aprire l'applicazione creata: policy *Allow* con le email autorizzate, metodo di accesso *One-time PIN*.
   - Copiare l'*Application Audience (AUD) Tag*.
   (Con un dominio proprio: Domini e route → *Add custom domain*, poi un'applicazione Access *Self-hosted* su quel dominio.)
5. Team Zero Trust della beta: `https://round-art-3b9a.cloudflareaccess.com`.
6. **Segreti del Worker.** Impostazioni → Variabili e segreti → aggiungere come **Secret**:
   - `ACCESS_TEAM_DOMAIN` = indirizzo del team (punto 5)
   - `ACCESS_AUD` = AUD Tag (punto 4)
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
