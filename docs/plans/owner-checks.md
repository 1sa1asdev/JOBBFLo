# Plan: Ägarkontroller

*Genomförd (del 4a) på grenen `feat/owner-checks`. Testresultat längst ned.*

## Mål

Ingen användare kan läsa, ändra eller skicka något som tillhör en annan, varken genom att byta ett id i en adress eller genom en lista som råkar visa allas rader. Det är det som måste vara stängt innan någon annan än du loggar in.

## Vad granskningen hittade

Alla 48 routes gicks igenom fråga för fråga. Problemen faller i tre grupper.

### 1. Rader som hämtas via id utan ägarkontroll

En inloggad användare kan byta id i adressen och komma åt en annan användares rader.

| Route | Vad som går att göra med någon annans id |
|---|---|
| `searches/[id]` (+ `/filters`, `/messages`, `/results`, `/scan`, `/score`, `/shortlist`) | läsa sökningen och chatten, ändra filter och kriterier, ta bort den, starta bedömningar **som debiteras ägaren** |
| `applications/[id]` (+ `/attachments`, `/external`, `/revise`) | läsa brevet, ändra det, byta CV-bilaga, markera som skickad |
| `applications/[id]/send` | **skicka någon annans brev** |
| `inbox/[id]`, `inbox/[id]/reply` | läsa en mejltråd, **svara arbetsgivaren i någon annans namn** |
| `suggestions/[id]` | avfärda någon annans svarsförslag |
| `autoapply/letter`, `/leads`, `/lead`, `/lead/bulk`, `autoapply` (PATCH/POST) | läsa och ändra en kampanj, slå på den, köra den |
| `autoapply/attachments` (DELETE) | radera någon annans bilaga |
| `cv` med `searchId` | byta CV på någon annans sökning |
| `ads/[id]` | se om någon annan har sökt annonsen, och **läsa någon annans checklista med citat ur deras CV** |

### 2. Listor och summor över alla användare

`inbox`, `dashboard`, `searches` (GET), `autoapply` (GET, med kampanjloggen), `pulse`, `stats`. Dessutom återställer `settings/llm` (PUT) parkerade bedömningar för *alla* användares sökningar, och kontrollen "redan kontaktad" i `autoapply/leads` tittar på alla användares utskick.

### 3. Användare som skriver i den gemensamma annonspoolen

- **Manuellt tillagda annonser** (`autoapply/lead`, `/lead/bulk`) hamnar i den gemensamma poolen, och sökningen filtrerar inte bort dem. En annons med en mejladress som användare A har skrivit in kan alltså hamna i användare B:s kampanj, och **B:s CV skickas till A:s adress**.
- **En mejladress som en användare skriver in** på en annons (`autoapply/leads` PATCH) sparas på den gemensamma annonsen, med samma risk.
- **"Visa aldrig"** (`never_apply`) döljer annonsen för alla.
- **"Länken öppnad"** (`ads.apply_url_opened_at`) delas av alla.

## Uppdelning

| PR | Innehåll |
|---|---|
| **4a. Ägarkontroller (den här planen)** | Grupp 1 och 2. Ren kod, inga schemaändringar. |
| 4b. Gemensam pool, personliga uppgifter (nästa) | Grupp 3. Kräver migrationer: manuella annonser och inskrivna adresser per användare, "visa aldrig" och "öppnad" per användare. |

4b måste också vara klar före lansering. Den är uppdelad för att den ändrar datamodellen, medan den här bara stänger dörrar.

## Ändringar (4a)

### Gemensamma kontroller i `src/owner.js`
- `ägerSökning(searchId, profileId)`, `ägerAnsökan(applicationId, profileId)` och `ägerFörslag(suggestionId, profileId)` svarar ja eller nej med en fråga var.
- Routes svarar **404 "finns inte"**, inte 403. Den som inte äger raden ska inte ens få veta att den finns.
- Kontrollen görs **först i varje route**, före allt annat: före filter, AI-anrop och utskick.

### Varje route i grupp 1
- `const profileId = await aktivProfilId();` följt av rätt kontroll, och 404 vid nej.
- Där en route redan hämtar raden läggs `AND profile_id = $n` till i samma fråga, i stället för en extra fråga.
- **`ads/[id]`:** ansökan hämtas bara för den egna profilen. Reserven "senaste checklistan för annonsen" tas bort. Bara checklistor från den egna sökningen visas.

### Varje route i grupp 2
- Alla listor och summor filtreras på `profile_id`: inkorgen, dashboardens fyra frågor, sökningslistan, kampanjlistan och loggen, pulsen, statistiken, återställningen i `settings/llm` och "redan kontaktad"-kontrollen.

### Beviset: `scripts/prove-owner-checks.js`, körs i CI
Det här är det som gör PR:en trovärdig. Det testar med två **riktiga inloggade användare** mot en riktig server, inte genom att läsa koden.
1. Startar appen med inloggning påslagen (`AUTH_SECRET`) mot en tom databas.
2. Skapar användare A och B via `/api/auth/signup`. Varje användare får sin egen sessionscookie.
3. Ger B en sökning, en ansökan med brev, en mejltråd, ett svarsförslag, en bilaga och en kampanj.
4. **Som A** anropas varje route i grupp 1 med B:s id. Alla ska svara 404, och B:s rader ska vara **oförändrade** efteråt.
5. **Som A** hämtas varje lista i grupp 2. Inga av B:s id:n får finnas med, och summorna ska bara räkna A:s rader.
6. **Som B** fungerar samma anrop. Det visar att kontrollerna inte bara stänger allt.
7. Utskick testas med B:s ansökan som A, och ska svara 404 utan att något anrop till Gmail görs.

En CI-spärr läggs också till: **varje route under `app/api` som tar ett id ska antingen anropa en ägarkontroll eller vara listad som gemensam** (annonser, orter, inloggning). En ny route utan kontroll fallerar då i CI.

## Test innan PR:en öppnas
1. Beviset ovan, lokalt och i CI, grönt.
2. Alla befintliga bevis och produktionsbygget gröna.
3. Med din riktiga profil i lokalt läge (utan `AUTH_SECRET`) fungerar appen som förut: sökningar, inkorg, dashboard, ansökningar.

## Utanför den här PR:en
- Grupp 3, den gemensamma poolen (PR 4b).
- Synkknappens signal `imap_sync_request`, som är gemensam. Den hör till PR:en med en mejlloop per användare.
- Supabase-inloggningen. Kontrollerna bygger på `aktivProfilId()`, så de fungerar oförändrade när den byter till Supabase-sessionen.

## Testresultat (19 okt)

**Beviset med två inloggade användare** (`scripts/prove-owner-checks.js`), mot en produktionsbyggd server med inloggning påslagen:

| | Gammal kod (`main`) | Ny kod |
|---|---|---|
| A:s anrop med B:s id som *inte* gav 404 | **28 av 32** | 0 av 33 |
| B:s rader oförändrade efter A:s anrop | nej, A hann ta bort B:s sökning, ändra brevet, markera det skickat, köra kampanjen och radera bilagan | ja |
| Annonsvyn läcker B:s checklista (citat ur B:s CV) | ja | nej |
| Listor och puls visar B:s rader | inkorgen och pulsen gjorde det | nej |
| B når sina egna rader | ja | ja |

Körningen mot den gamla koden visar att beviset kan bli rött och fångar riktiga hål. Den första körningen mot "gammal kod" var ogiltig: den förra servern höll fortfarande port 3100. Det upptäcktes och gjordes om.

- **Lokalt läge med din profil** (utan inloggning): sökningar, inkorg, ansökningar, dashboard, kampanjer, puls och statistik svarar 200 med samma antal rader som innan (3 aktiva sökningar, 13 trådar). Okända eller felaktiga id:n ger nu 404 i stället för fel.
- **CI-spärren** "varje route som tar någons id kontrollerar ägaren" slog till på en provroute utan kontroll och är grön på koden.
- **Alla bevis** och produktionsbygget är gröna. Beviset med två användare körs nu i CI efter bygget.

### Upptäckt på vägen
- **`applications` (POST)** skapade ett brevutkast "från" en sökning utan att kontrollera vems den var. Eftersom sökningen avgör vilket CV brevet skrivs från, kunde det bli ett brev byggt på **någon annans anpassade CV**. Spärren hittade det, och det är stängt och tillagt i beviset.
- **`\b` före "ä"** fungerar inte i JavaScripts reguljära uttryck. Spärrens första version flaggade därför 25 routes. Rättat.
