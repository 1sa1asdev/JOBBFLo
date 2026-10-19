# Plan: AI-nycklar per användare

*Genomförd på grenen `feat/per-user-ai-keys`. Testresultat längst ned.*

## Mål

Varje AI-anrop vet vems det är, och körs med den användarens nyckel, modellval och budget. Kostnaden loggas per användare. Det enda du som operatör betalar för är embeddings av annonspoolen, med din egen plattformsnyckel.

## Uppdelning

| PR | Innehåll |
|---|---|
| **3a. AI-nycklar per användare (den här planen)** | Nyckel, modeller och kvotspärrar per användare. Kostnader loggas per användare. Ingen reserv till `.env`. Plattformsnyckel för embeddings. |
| 3b. Kravläsning per användare (nästa) | Annonsens kravlista sparas per användare och modell i stället för en gång per annons, plus kontrollpunkten som stoppar bedömning när läsningen är för tunn. |

3b bygger på 3a, så den här kommer först. Fram till 3b sparas kravlistan fortfarande gemensamt per annons, men läsningen betalas av den användare som utlöser den.

## Läget i dag (kontrollerat)

- **Nyckeln och modellerna ligger redan i profilen,** krypterade. Men `src/llm.js` hämtar dem för "den enda profilen" (`endaProfilId()`), eftersom inget anrop berättar vems det är. Med två profiler vägrar den, som avsett.
- **Om profilen saknar AI-inställning används `.env`** (`OPENROUTER_API_KEY` med flera). Med flera användare skulle det betyda att du betalar för alla som inte lagt in en nyckel.
- **Kvotspärrarna ligger i minnet per modell, inte per nyckel.** Om en användare tömmer sin gratiskvot spärras modellen för *alla*, trots att deras nycklar har egna kvoter. Samma sak gäller minutgränserna (token-hinken).
- **`llm_usage` saknar användare.** Månadskostnaden och budgeten under Profil räknas därför över alla, och saldot hos OpenRouter hämtas med nyckeln i `.env`.
- **Embeddings** använder `OPENROUTER_API_KEY` från `.env`. Det är rätt i princip, eftersom det är plattformens kostnad, men det borde vara en egen plattformsnyckel.
- **Det finns 14 anropsställen.** Alla vet redan vems anropet är, via ansökan, sökningen eller routen:

| Fil | Vad | Ägaren kommer från |
|---|---|---|
| `checklist.js` / `adprofile.js` | bedömning, kravläsning | sökningens `profile_id` (bedömningskön) |
| `letters.js` (2) | brev, revidering | ansökans `profile_id` |
| `classify.js` (3) | klassning av svar, svarsutkast, intervjuförberedelse | ansökans `profile_id` |
| `claims.js` | kontroll av brevets påståenden | ansökans `profile_id` |
| `followups.js` | utkast till påminnelse | ansökans `profile_id` |
| `campaign.js` | kampanjbrev | sökningens `profile_id` |
| `chat.js` | sökchatten | sökningens `profile_id` |
| `score.js` (`parseCriteria`) | kriterier → filter | routen (`aktivProfilId`) eller sökningen |
| `cvprofile.js` | läsning av CV | profilen eller sökningen |
| `lead/parse` (route) | klistrade kontakter | routen |
| `settings/llm/test` (route) | "Testa anslutning" | nyckeln som skrivits in, eller din sparade |

## Ändringar

### `src/llm.js`
- **`llmText`/`llmJson` tar `profileId`.** Inställningen (leverantör, nyckel, modeller per nivå) hämtas för just den profilen och cachas per profil.
- **Ingen reserv till `.env`.** En profil utan AI-inställning får felet "Ingen AI-leverantör vald — lägg in en nyckel under Profil", aldrig serverns nyckel. Samma gäller extranycklar för andra leverantörer i en modellkedja.
- **Kvotspärrar och minutgränser per nyckel** i stället för per modell. Den ena användarens tomma kvot påverkar inte någon annan. Inställningssidan visar bara spärrarna för den egna nyckeln.
- **Anrop utan `profileId`** faller tillbaka på `endaProfilId()`, så att skript fortsätter fungera lokalt. Det vägrar när det finns flera profiler. All kod i `src/` och `app/` ska skicka med `profileId`, och CI kontrollerar det (se nedan).

### De 14 anropsställena
- **Varje anrop skickar med `profileId`** från raden eller routen enligt tabellen ovan. Funktioner som `parseCriteria`, `buildCvProfile`, `classifyReply` och `checkAd` får en `profileId`-parameter.
- **Kravläsningen i bakgrunden** (`AD_PROFILES=1` i workern, avstängd i dag) har ingen ägare, så den skulle bli en plattformskostnad, vilket strider mot beslutet att användare betalar läsning. **Den tas bort.** Läsning sker bara när en användare bedömer en annons.

### Kostnad per användare: migration 046
- **`llm_usage.profile_id`** (som får vara tomt för plattformsanrop). Varje anrop loggar sin ägare.
- **Budgeten under Profil:** "spenderat denna månad" räknas för din profil. Saldot hos OpenRouter hämtas med *din* nyckel, inte med `.env`.
- **Snittkostnaden per uppgift** (en bedömning, ett brev) räknas fortfarande över alla. Det är ett anonymt snitt och underlaget för kostnadsuppskattningen i onboarding.

### Plattformsnyckel för embeddings
- **`src/embed.js`** använder en ny inställning, `PLATFORM_OPENROUTER_API_KEY`, din egen nyckel för poolen. Lokalt används `OPENROUTER_API_KEY` som reserv tills du skapat en separat nyckel, och workern loggar det tydligt.
- **Ingen annan kod** får använda plattformsnyckeln.

### Skydd i CI: `prove-profile-scope.js` utökas
- **Ingen kod i `src/` eller `app/` får läsa användares AI-nycklar ur miljön.** Det enda undantaget är plattformsnyckeln i `embed.js`.
- **Varje `llmJson`/`llmText`-anrop** i `src/` och `app/` måste skicka med `profileId`, eller en uttrycklig `config` som "Testa anslutning" gör.

## Test innan PR:en öppnas
1. Migration 046, `db:schema`, och `db:check` grön.
2. **Med alla AI-nycklar tomma i miljön:** ett riktigt, billigt anrop (klassning av ett kort mejl, cirka 0,06 öre) går via din profil, och raden i `llm_usage` har din `profile_id`.
3. **Isolering med en tillfällig andra profil utan nyckel:** dess anrop får "Ingen AI-leverantör vald", samtidigt som ditt anrop fungerar. Det visar att den andra profilen varken använder din nyckel eller `.env`. Profilen tas bort efteråt, även om testet avbryts.
4. **Kvotspärr per nyckel:** en spärr på en nyckel påverkar inte en annan nyckels anrop.
5. **Embeddings** går via plattformsnyckeln, och workern inbäddar nya annonser som vanligt.
6. **Budgetsidan** visar din månadskostnad och ditt saldo.
7. Alla bevis och produktionsbygget gröna lokalt, sedan i CI.

## Utanför den här PR:en
- Kravläsning per användare och modell, och kontrollpunkten för tunna läsningar (PR 3b).
- En IMAP-loop per användare i workern.
- Adminsidan, med plattformsinställningar och embedding-modell.
- Onboarding med modellval och kostnadsuppskattning.

## Inga frågor till dig den här gången
Allt ovan följer besluten i roadmapen: användare betalar sitt eget, du betalar bara poolen, och inget hämtas ur `.env` för användare.

## Testresultat (19 okt)

- **Migration 046** körd. Alla 6 744 tidigare anrop i `llm_usage` kopplades till den enda profilen. `db:check` är grön för schemafilen och för den riktiga databasen.
- **Med alla användarnycklar tomma i miljön** (bara plattformsnyckeln satt):
  - ett riktigt anrop (klassning av ett mejl) gick på profilens nyckel, och kostnaden loggades på profilen ($0.00003)
  - en tillfällig andra profil utan nyckel fick "Ingen AI-leverantör vald", samtidigt som min profil fungerade. Varken min nyckel eller `.env` användes för den.
  - kvotspärr per nyckel, mot en lokal låtsasleverantör: nyckel A fick "dagskvot slut" och spärrades, nyckel B fungerade, och A:s nästa anrop stoppades utan att nå leverantören. Inställningssidan för en profil visar inte en annan nyckels spärrar.
  - embedding gick via plattformsnyckeln (768 dimensioner)
- **Routes:** budget, AI-inställningar, modellista och dashboard svarar 200. Budgeten visar den egna profilens kostnad och saldot på den egna nyckeln.
- **CI-spärrarna** (ingen AI-nyckel ur miljön, varje AI-anrop har en ägare) slog till på en provfil med båda felen och är gröna på koden.
- **Alla bevis** och produktionsbygget är gröna.

### Upptäckt på vägen
- **Dashboardens kostnadsruta har aldrig visats.** Den frågade efter kolumnerna `cost_usd` och `created_at`, som aldrig funnits, och felet svaldes. Rättad, och avgränsad till den egna profilen. Den visar nu $0.80 och 575 anrop för oktober.
- **Minutgränsen räknade aldrig verklig förbrukning.** Förbrukningen bokfördes under modellnamnet, medan väntan läste "leverantör:modell". Nu används samma hink för båda, per nyckel.
- **`quotaBlockedUntil`** var en spärr som aldrig sattes. Den är borttagen.
