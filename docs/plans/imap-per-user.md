# Plan: En mejlloop per användare

*Genomfört på grenen `feat/imap-per-user` (20 okt). Migration 051 är körd lokalt efter en säkerhetskopia (`jobbflo-20261020-1608.dump`).*

## Mål

Varje användare som kopplat Gmail får sin egen inkorg bevakad: svar kommer in inom några sekunder, kopplas till **den användarens** ansökningar och syns bara för den användaren. Workern startar och stoppar bevakningen själv när användare kopplar till eller från Gmail.

## Beslut (19–20 okt)

- **Bara det användaren startat via appen bevakas.** Bevakningen börjar när användaren skickar sitt första brev via appen, och läser post från det första utskicket och framåt. Ingenting i användarens historik före det läses, och en användare som kopplat Gmail men inte skickat något har ingen loop alls.
- **Mejlfunktionen är isolerad och instansierad per användare.** Varje användare har en egen instans med eget tillstånd i databasen: läsposition, knappsignal och felstatus. Ingenting i mejlfunktionen är gemensamt mellan användare.
- **"Hämta post" hämtar bara den egna posten,** aldrig andra användares.
- **Testet med två riktiga Gmail-konton görs efter lansering,** med ett testkonto du skapar då.

## Läget i dag (kontrollerat)

| Del | I dag | Problem med flera användare |
|---|---|---|
| **Loopen** (`runImapLoop`) | en enda anslutning, till "den enda profilen" (`endaProfilId()`) | med två profiler vägrar den, och ingen användares post läses |
| **Var loopen senast läste** (`imap_state`) | en rad per mapp (`INBOX`) för hela appen | två användares inkorgar skulle skriva över varandras position |
| **Koppla svar till ansökan** (`matchReply`) | letar bland *alla* användares ansökningar | domänfallet (svar från `anna@volvo.se` till en ansökan till `jobb@volvo.se`) kan koppla ett svar i A:s inkorg till **B:s** ansökan. A:s mejl hamnar då i B:s tråd och ändrar B:s status. |
| **Synken av Skickat** (`catchUpSent`) | letar efter trådar och fastnade utskick hos alla användare | A:s Skickat-mapp söks efter B:s mottagare |
| **"Hämta post"** (`imap_sync_request`, `imap_worker_alive`) | en gemensam signal i `poll_state` | A:s knapptryck hämtar fel inkorg, eller allas |
| **Timrar** | tre per anslutning: Skickat var 5:e min, inkorg var 2:a min, knappen var 3:e sekund | med N användare blir det N frågor var 3:e sekund bara för knappen |

## Ändringar

### Migration 051: läsposition och knapp per användare
- `imap_state` får `profile_id`, med primärnyckel (användare, mapp). Din nuvarande position flyttas till din profil.
- Knappens signal flyttas från `poll_state` till en egen tabell `imap_sync_requests (profile_id, requested_at, done_at)`, en rad per användare.
- Den gemensamma "workern lever"-signalen ligger kvar i `poll_state`. Den gäller processen, inte en användare.

### Koppling av svar: alltid inom ägarens ansökningar
- `matchReply` får **brevlådans ägare** och letar bara bland den användarens ansökningar, i alla fem stegen i CLAUDE.md:s ordning. Ett svar i A:s inkorg kan bara kopplas till A:s ansökningar.
- Samma sak gäller `handleSent`, `catchUpSent` och lagningen av fastnade utskick: bara ägarens trådar, bara ägarens Skickat.

### Loopen blir en ansvarig per användare: `src/imapManager.js`
- **Startar en loop per användare** med verifierat Gmail (`gmail_verified_at` satt) **och minst ett brev skickat via appen**. Var 60:e sekund jämförs listan, så att en användare som kopplar Gmail börjar bevakas inom en minut och en som kopplar bort slutar bevakas.
- **Varje loop återansluter för sig,** med egen backoff. En användares trasiga anslutning påverkar ingen annan.
- **Knappen "Hämta post"** besvaras av den ansvarige: en fråga var 3:e sekund för *alla* användare, i stället för en per användare, som sedan väcker rätt loop.
- **Fel lösenord** (Google har återkallat applösenordet, eller användaren bytt lösenord): loopen slutar försöka efter några misslyckanden i rad, markerar profilen (`gmail_verified_at` nollställs, och felet sparas) och väntar tills användaren lägger in ett nytt lösenord. Inställningssidan visar då "Gmail svarar inte: lösenordet fungerar inte längre". Annars skulle workern hamra på Google tills kontot låses.
- **Läsningen börjar vid användarens första utskick via appen,** inte vid inkorgens början. Första gången en användares loop ansluter frågar den Gmail efter post sedan det första utskicket (IMAP SEARCH SINCE), och sparar sedan sin egen position. Allt äldre lämnas orört.

### Gränser att känna till
- Gmail tillåter 15 samtidiga IMAP-anslutningar per konto. Appen använder en per användare, plus en kort extra när knappen trycks utan att workern är igång.
- En Node-process klarar hundratals vilande anslutningar. Längre fram, vid många hundra användare, delas användarna upp på flera workers. Det är inte en fråga för lanseringen, men designen (en ansvarig som delar ut loopar) gör det enkelt.

## Bevis

Två verkliga Gmail-konton går inte att köra i CI. Beviset delas därför i två delar.

### I CI: `scripts/prove-imap-scope.js`
- Två profiler, A och B. Båda har ansökningar till samma arbetsgivardomän (`@volvo.example`).
- **Kopplingen:** ett svar från `anna@volvo.example` i A:s brevlåda kopplas till A:s ansökan och aldrig till B:s, i alla fem stegen. Ett svar som bara matchar B ska inte kopplas alls hos A.
- **Läsposition:** A:s och B:s positioner är separata.
- **Den ansvarige:** med en låtsas-IMAP-klient (ingen nätverkstrafik) startar den en loop per verifierad användare, startar en ny när en användare verifieras, stoppar när en kopplar bort, och slutar försöka efter upprepat fel lösenord.
- **Kontroll mot den gamla koden först,** som förut: kopplingen ska bli röd där.

### Lokalt, med ditt riktiga konto
- Workern startar, din loop ansluter, och svar och "Hämta post" fungerar som i dag.
- **Valfritt men värdefullt:** om du skapar ett andra Gmail-konto för test kan jag köra hela kedjan med två riktiga inkorgar: ett mejl till vardera, och kontroll att varje svar hamnar hos rätt användare. Det kräver att du skapar kontot och dess applösenord. Det kan jag inte göra åt dig.

## Vad som hände under bygget

- **Beviset var rött mot den gamla koden** i sju kopplingsfall: ett svar i A:s brevlåda kopplades till B:s ansökan (via message-id, References och domän), och när både A och B skrivit till samma domän kopplades A:s svar inte alls.
- **"Hämta post" hängde sig** om knappen trycktes medan brevlådan läste Skickat vid start: inkorgen bytte mapp utan att vänta på Skickat-låset, och båda väntade sedan för evigt. Inkorgen tar nu samma lås. Efter varje Skickat-pass väljs INBOX igen, annars hade IDLE fortsatt att bevaka Skickat.
- **Tidsstämpeln på knappens begäran tappade mikrosekunder** på vägen genom JavaScript, så routen kände aldrig igen svaret och väntade ut hela tidsgränsen. Den går nu som text. Beviset fångade felet.
- **Uppmätt med ditt konto:** "Hämta post" via workern tar 2,8 s. Utan workern tar det 14 s, med en egen anslutning.
- **Den ansvarige svarar bara för användare den har en brevlåda för.** För alla andra läser routen själv direkt, i stället för att vänta på ett svar som aldrig kommer. Det håller också när användarna senare delas upp på flera workers.
- **Ett lösenord som inte går att läsa** (plattformens nyckel bytt) markeras på samma sätt som ett nekat lösenord, i stället för att startas om varje minut.
- `scripts/check-inbox.js` och `scripts/sync-sent.js` läste Gmail från `.env`. De tar nu en profil och använder dess sparade lösenord.

## Utanför den här PR:en
- Gmail via Googles API (efter godkännandet), som byter transporten under loopen men inte loopen själv.
- Uppdelning på flera workers vid många användare.
- Notiser vid nya svar (finns i dag i webbläsaren; per användare följer automatiskt när inkorgen är det).

## Frågor till dig
1. ~~Ett andra Gmail-konto för test~~ ✅ *Besvarad: skapas när appen är live, och testet med två riktiga inkorgar görs då.*
