# Plan: Gmail per användare

*Genomförd på grenen `feat/per-user-credentials`. Testresultat längst ned.*

## Mål

Ingen användares uppgifter ska ligga i `.env`. Varje användare lägger in sitt Gmail-applösenord efter inloggning. Det sparas krypterat i deras profil och används bara för deras egen post. Appen ska byggas och köras utan att något användarspecifikt finns i miljön.

## Uppdelning i två PR:er

| PR | Innehåll |
|---|---|
| **1. Gmail per användare (den här planen)** | Applösenordet krypterat i profilen. Mejlkoden läser därifrån i stället för `.env`. "Testa anslutning" i inställningarna. Egen krypteringsnyckel. |
| 2. AI-nycklar per användare (nästa) | Varje AI-anrop får veta vems nyckel och budget det gäller. Kostnader loggas per användare. Embeddings går på din plattformsnyckel. |

Varför Gmail först: det är mindre, det står för sig självt, och onboarding bygger på det.

## Läget i dag (kontrollerat)

- **Applösenordet** läses från `.env` på fyra ställen: `src/mailer.js` (sändning, avsändaradress) och `src/imap.js` (inloggning, och filtret som hoppar över mejl från dig själv).
- **Profilens mejladress är redan samma som `GMAIL_USER`.** Adressen behöver alltså inte flyttas, bara lösenordet.
- **AI-nyckeln ligger redan krypterad i profilen.** Den rörs inte i den här PR:en.
- **Krypteringen** (`src/secrets.js`, AES-256-GCM) hämtar sin nyckel från `AUTH_SECRET`. När Supabase tar över inloggningen har `AUTH_SECRET` inget med sessioner att göra längre.
- **Workern har en enda IMAP-loop**, inte en per användare.

## Ändringar

### Databas: migration 045
- `profile.gmail_app_password_enc text`: applösenordet, krypterat.
- `profile.gmail_verified_at timestamptz`: när en inloggning mot Gmail senast lyckades.
- `COMMENT ON` för båda, som för allt annat i schemat.

### Kryptering: `src/secrets.js`
- Nyckeln hämtas från en ny plattformsinställning, `ENCRYPTION_KEY`, i första hand. `AUTH_SECRET` och utvecklingsnyckeln finns kvar som reserv, så att det som redan är krypterat lokalt (din AI-nyckel) fortfarande går att läsa.
- I produktion är `ENCRYPTION_KEY` ett krav, och appen vägrar starta utan den.

### Ny modul: `src/credentials.js`
- `gmailFör(profileId)` returnerar adress och lösenord för just den profilen.
- **Ingen reserv till `.env`.** Saknas lösenordet får man ett tydligt fel: "Gmail är inte kopplat — lägg in ett applösenord under Profil".
- Mellanslagen som Google visar i lösenordet tas bort, som i dag.

### Mejlkoden
- **`src/mailer.js`:** sändning och svar hämtar uppgifterna från ansökans ägare (`app.profile_id`), och avsändaradressen kommer från profilen. Samma mönster som profilsömmen.
- **`src/imap.js`:** loopen loggar in med den enda profilens uppgifter (`endaProfilId()`, som vägrar gissa om det finns flera). Filtret för egna mejl jämför mot profilens adress.
  - En loop per användare är en egen PR i roadmapen. Den här PR:en gör bara att loopen inte behöver `.env`.
- **Saknas applösenord** när workern startar, loggar den det och väntar. Den kraschar inte, och den försöker igen när ett lösenord har lagts in.

### Nya API-routes: `/api/settings/gmail`
- `GET`: om Gmail är kopplat, vilken adress, och när det senast verifierades. **Lösenordet skickas aldrig tillbaka**, inte ens maskerat.
- `PUT { address, password }`: **testar först**, med inloggning mot både SMTP (sändning) och IMAP (läsning). Sparar bara om båda fungerar. Annars returneras ett begripligt felmeddelande, till exempel "Fel lösenord — kontrollera att du kopierat applösenordet, inte ditt vanliga lösenord".
- `DELETE`: kopplar bort.
- Allt via `aktivProfilId()`, alltså din profil och ingen annans.

### Gränssnitt: ny sektion under Profil
- **"Gmail"** med adress, ett fält för applösenordet och knappen "Testa och spara".
- **Kort guide:** tvåstegsverifiering måste vara på, länk till `myaccount.google.com/apppasswords`, och "kopiera de 16 tecknen".
- **Status:** "Kopplat — verifierat 19 okt" eller "Inte kopplat".
- Byggs med samma stil och mönster som den befintliga AI-inställningen (`LlmSettings.jsx`).

### Engångsflytt för din lokala miljö
- `scripts/import-gmail-from-env.js` läser `GMAIL_APP_PASSWORD` ur din `.env` **en gång**, testar inloggningen, krypterar och sparar den i din profil. Därefter kan raden tas bort ur `.env`.
- Ingen kod läser den raden efter den här PR:en.

### Skydd mot att det smyger tillbaka
- `scripts/prove-profile-scope.js` utökas: **ingen kod i `src/`, `app/` eller `lib/` får läsa `GMAIL_USER` eller `GMAIL_APP_PASSWORD` ur miljön.** CI fallerar annars.

## Test innan PR:en öppnas
1. Migrationen körs, `db:schema` görs om och `db:check` är grön.
2. Importskriptet flyttar ditt lösenord. **Därefter tas `GMAIL_*` bort ur miljön för testet**, för att bevisa att inget läser den längre.
3. Workern startar om och loggar in mot Gmail med uppgifterna från profilen. Inkommande post tas emot.
4. "Testa och spara" i gränssnittet: fel lösenord ger ett tydligt fel och sparar inget, rätt lösenord sparas.
5. Sändning testas **mot din egen adress**, aldrig mot en arbetsgivare.
6. Alla bevis och produktionsbygget gröna lokalt, sedan i CI.

## Utanför den här PR:en
- AI-nycklar per användare och kostnad per användare (PR 2).
- En IMAP-loop per användare i workern (egen PR).
- Onboarding-guiden. Den återanvänder routen och sektionen härifrån.
- Gmail via Googles API (efter Googles godkännande).

## Frågor till dig
1. **Avsändaradress:** ✅ *Besvarad: avsändaren är alltid användaren själv, med profilens adress.* Inget eget adressfält.
2. **`.env` lokalt:** ✅ *Besvarad: `.env` ligger kvar orörd lokalt, för test med Docker.* Raderna `GMAIL_*` blir oanvända men ofarliga. Lösenordet kopieras in i profilen en gång med importskriptet.

## Testresultat (19 okt)

- **Migration 045** körd lokalt. `db:check` är grön, både för schemafilen och för den riktiga databasen.
- **Importskriptet** testade inloggningen (sändning ok, läsning ok) och sparade lösenordet krypterat i profilen.
- **Med `GMAIL_USER` och `GMAIL_APP_PASSWORD` tomma i miljön** fungerade allt via profilen:
  - läsning: 754 meddelanden hämtade
  - sändning: ett testmejl gick till den egna adressen genom den riktiga sändningsvägen, med profilens adress som avsändare
  - fel lösenord: avvisades med ett begripligt felmeddelande
- **Workern i Docker** loggade in med profilens uppgifter (`imap: connected (…)`) och arbetar som vanligt.
- **Gränssnittet:** sektionen visar "Kopplat — verifierat". Ett felaktigt lösenord visade felet och skrev inte över det fungerande lösenordet.
- **Alla bevis** är gröna, inklusive den nya kontrollen att ingen kod läser Gmail-uppgifter ur miljön. Produktionsbygget går igenom.

### Upptäckt på vägen
- **`prove-profile-scope` lämnade en testprofil kvar när det avbröts** (utskrift som klipptes med `head`). Med två profiler vägrar workern, som det är tänkt. Beviset tar nu bort en sådan rest innan det börjar.
- **`catchUpSent` letar efter trådar över alla profiler.** Det spelar ingen roll med en enda loop, men måste avgränsas per ägare i PR:en för en loop per användare.
