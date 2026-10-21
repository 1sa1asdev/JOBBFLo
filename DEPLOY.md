# Göra Jobbflo live

Fyra delar, och Postgres är det enda de delar:

```
                    Google (inloggning)
                          │
Supabase  ◄── Vercel (appen + API)        ← användarna
(Postgres     Railway (worker: post, JobStream, kampanjer;
 + Auth)      ◄──      janitor: annonspoolens städning)
   ▲
   └── GitHub Actions: CI på varje PR, migrerar databasen och flyttar
       grenarna `staging` / `production` som Vercel och Railway bygger från
```

Två miljöer, **staging** och **production**, var och en med egen Supabase,
egen Vercel-miljö och egen Railway-miljö. Koden når aldrig en databas som är
äldre än den: `.github/workflows/deploy.yml` migrerar först och flyttar grenen
sedan.

Det som inte går att automatisera (konton, nycklar, Googles godkännande) är
dina steg nedan. Allt som står i kodblock går att köra som det står.

---

## 0. Konton och vad de kostar

| Tjänst | Plan | Varför |
|---|---|---|
| Supabase | **Pro, $25/mån** (organisationen) | databasen är 1,3 GB, gratisnivån tar 0,5 GB; dagliga säkerhetskopior |
| Vercel | Hobby (gratis) tills appen tar betalt — då Pro, $20/mån | Hobby är bara för icke-kommersiellt bruk |
| Railway | Hobby, $5/mån | worker och janitor måste vara igång dygnet runt |
| Google Cloud | gratis | OAuth-klienten för inloggningen |
| OpenRouter | plattformsnyckel med kreditgräns | annonspoolens embeddings, ~$0,70/mån |

Staging kan ligga som ett andra projekt i samma Supabase-organisation.

---

## 1. Supabase — två projekt

Skapa **jobbflo-staging** och **jobbflo** i regionen **North EU (Stockholm)**.
För vart och ett, anteckna:

- **Connect → Session pooler**: anslutningssträngen (port **5432**). Inte
  transaktionspoolern (6543): workerns och bedömningens rådgivande lås kräver
  en session. Inte heller den direkta anslutningen, som bara har IPv6.
- **Database → Settings → SSL Configuration**: ladda ner certifikatet
  (→ `DATABASE_CA_CERT`).
- **Project Settings → API**: `URL`, `anon`-nyckeln och `service_role`-nyckeln.

**Authentication → Sign In / Providers**:
- **Google**: på, med klient-id och hemlighet från steg 2.
- **Email**: av. Google är enda vägen in.

**Authentication → URL Configuration**:
- Site URL: `https://<din-domän>` (staging: `https://staging.<din-domän>`)
- Redirect URLs: `https://<din-domän>/auth/callback`

---

## 2. Google — OAuth-klienten

I [Google Cloud Console](https://console.cloud.google.com), ett projekt "Jobbflo":

1. **OAuth consent screen**: External, appnamn *Jobbflo*, support-mejl, och
   - Privacy policy: `https://<din-domän>/integritet`
   - Terms of service: `https://<din-domän>/villkor`
   - Authorized domains: din domän och `supabase.co`
   - Scopes: bara `openid`, `email`, `profile`. De är inte känsliga, så
     inloggningen behöver ingen granskning hos Google.
2. **Credentials → Create OAuth client ID → Web application**:
   - Authorized redirect URI: `https://<projekt-ref>.supabase.co/auth/v1/callback`
     (en för staging, en för production, eller två klienter)
3. **Publish app** (In production), så att alla Google-konton kan logga in.

Gmail via OAuth (i stället för applösenord) är ett senare steg och kräver
Googles granskning av begränsade scopes. Se roadmapen.

---

## 3. Databaserna

Nycklarna från steg 1 skriver du in i `.env.supabase` i repots rot. Filen är
gitignorerad, och kommentarerna i den säger var varje värde finns.
Certifikaten sparar du som `supabase/staging-ca.crt` och
`supabase/prod-ca.crt`. Skripten nedan läser filen och skriver aldrig ut
lösenord eller nycklar.

### Båda: byggda från migrationerna

```bash
node scripts/setup-supabase.js staging
```

```bash
node scripts/setup-supabase.js production
```

Varje körning slutar med samma kontroller som leveranskedjan gör: databasen
stämmer med migrationerna, Data API:t är låst, och den publika nyckeln läser
ingenting. Annonspoolen fylls sedan av janitorn (steg 5), och den första
ögonblicksbilden tar några minuter.

### Din historik: flyttad in i ditt konto

Det här görs när appen är uppe (steg 7), inte före:

1. Logga in i molnappen med Google en gång. Då finns ditt konto.
2. Flytta din lokala historik in i det:

```bash
node scripts/flytta-historik.js production
```

Bara det som är ditt flyttas: sökningar, bedömningar, checklistor, ansökningar,
brev, mejltrådar, kampanjer och CV. Annonserna matchas mot molnets pool, och de
som saknas där läggs till. Alla rader får nya id:n. Flytten görs bara till ett
konto som ännu inte har sökningar eller ansökningar, och bara mellan databaser
på samma migration. Nycklar flyttar inte: lägg in applösenordet och AI-nyckeln
igen under Profil. Produktionen har en egen `ENCRYPTION_KEY`, och det är med
flit.

Kampanjerna kommer fram **pausade**. Stäng av den lokala workern innan du
startar dem i molnet:

```bash
docker compose stop worker janitor
```

Annars kör kampanjerna från två databaser, och arbetsgivare får dubbla brev.

Generalrepetitionen gjordes 20 okt mot en lokal Supabase med din riktiga
historik: 21 sökningar, 538 ansökningar, 761 mejl och 1 586 checklistor på 4
sekunder. Inloggningen visade sedan allt. Att radera kontot efteråt hittade en
bugg (migration 058), som är rättad.

Vill du hellre flytta hela den lokala databasen, med annonspool och allt, in i
ett tomt projekt finns `node scripts/setup-supabase.js production --flytta`.
Det passar bara innan någon annan har ett konto.

### Admin

Efter din första inloggning:

```bash
DATABASE_URL="<production session pooler>" node scripts/make-admin.js <din-gmail>
```

---

## 4. Vercel — appen

Importera repot. Under **Settings**:

- **Git → Production Branch**: `production`
- **Domains**: `<din-domän>` → production, `staging.<din-domän>` → grenen `staging`
- Bygget hoppas över för alla andra grenar (`vercel.json` → `scripts/vercel-ignore.sh`):
  en PR-förhandsvisning skulle köra omigrerad kod mot stagingdatabasen.
- Funktionsregion: `arn1` (Stockholm, bredvid Supabase), satt i `vercel.json`.

**Environment Variables**: Production-värden för miljön *Production*, och
staging-värden för *Preview*, avgränsade till grenen `staging`:

| Variabel | Värde |
|---|---|
| `DATABASE_URL` | session pooler, utan `sslmode` |
| `DATABASE_CA_CERT` | certifikatet, som text |
| `PG_POOL_MAX` | `3` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | från steg 1 |
| `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`, en per miljö |
| `PLATFORM_OPENROUTER_API_KEY` | plattformens nyckel (sökningarnas frågevektorer) |
| `JOBBFLO_OPERATOR`, `JOBBFLO_KONTAKT` | ditt namn eller företag och en kontaktadress. De visas i integritetspolicyn och villkoren och hålls utanför repot |

Sätt **inte** `AUTH_SECRET` eller `JOBBFLO_UTAN_INLOGGNING` här.

---

## 5. Railway — worker och janitor

Ett projekt med miljöerna **production** och **staging**. I varje miljö finns två
tjänster från samma repo:

| Tjänst | Config file path | Gren (production / staging) |
|---|---|---|
| worker | `railway.json` | `production` / `staging` |
| janitor | `railway.janitor.json` | `production` / `staging` |

Båda bygger `Dockerfile` (Node 22). Variabler per miljö: `DATABASE_URL`,
`DATABASE_CA_CERT`, `ENCRYPTION_KEY` (samma som Vercel i den miljön),
`PLATFORM_OPENROUTER_API_KEY`, `JOBSTREAM_API_KEY`, `TZ=Europe/Stockholm`.

Bara **en** worker per miljö: den tar ett rådgivande lås, och en andra
väntar tills låset blir ledigt. Så tar en ny deploy över när Railway
stänger den gamla, utan att det någonsin står noll workers. Janitorns dagliga ögonblicksbild är några hundra MB, så
ge den minst 1 GB minne.

---

## 6. GitHub — miljöer och skydd

**Settings → Environments**:
- `staging` och `production`, var och en med hemligheterna `DATABASE_URL`,
  `SUPABASE_URL`, `SUPABASE_ANON_KEY` och `DATABASE_CA_CERT` (certifikatets
  text). Utan certifikatet krypteras migrationerna ändå, men servern
  verifieras inte
- `production`: **Required reviewers** = du. Ingen release migrerar
  produktion utan ditt godkännande.

**Settings → Secrets and variables → Actions → Variables**: lägg till
`DEPLOY_ENABLED` = `true` när allt ovan finns. Innan dess gör en merge
ingenting mer än att köra CI.

**Settings → Branches → main**: kräv pull request och att CI-jobben
`schema`, `proofs`, `build-e2e` och `supabase` är gröna.

---

## 7. Första driftsättningen

1. Merga PR:en till `main`. CI körs, och när den är grön migrerar
   `deploy.yml` staging och flyttar `staging`. Vercel och Railway bygger.
2. Logga in på `https://staging.<din-domän>` med Google, gå igenom guiden
   och skicka ett testbrev till dig själv.
3. **Releases → Draft a new release**, tagg `v1.0.0` från `main` → Publish.
   Godkänn i Actions. Produktionsdatabasen migreras och kontrolleras, och
   först därefter flyttas `production`.
4. Logga in på `https://<din-domän>` med Google. Kör sedan `make-admin` och
   `flytta-historik.js production` (steg 3), stäng av den lokala workern,
   lägg in applösenord och AI-nyckel under Profil, och starta kampanjerna.
   Vill du prova flytten först går samma kommando mot staging:
   `node scripts/flytta-historik.js staging`.

---

## 8. Varje release efter det

```
gren → PR → CI grönt → merge → staging (automatiskt) → testa → release → godkänn → production
```

Migrationer körs medan den förra koden fortfarande är igång. De måste
därför fungera med koden före dem: lägg till, fyll i, byt över, och ta bort
det gamla först i en senare release. Byt aldrig namn på något direkt.

### Att releasen faktiskt kör

Att grenen flyttas betyder bara att Vercel och Railway ombeds bygga. Den
21 okt låg Railway nere när `production` flyttades: körningen blev grön,
appen körde den nya koden och workern den gamla i flera timmar, utan att
något sa det.

Därför slutar `deploy.yml` med att vänta tills appen (`/api/health`),
workern och janitorn svarar med just den commit som släpptes
(`scripts/verify-deploy.js`). Workern och janitorn skriver sin commit med
sina hjärtslag, och bara den som håller låset slår, så en ny version där
betyder att den nya containern har tagit över. Efter 5 minuter puffas den
som släpar en gång, och efter 15 blir körningen röd och säger vilken del
som inte kom upp.

Per miljö under **Settings → Environments** (allt är valfritt; utan
`APP_URL` och `VERIFY_WORKER` hoppas steget över):

| Typ | Namn | Värde |
|---|---|---|
| Variabel | `APP_URL` | `https://jobbflo.vercel.app` (staging: grenens adress i Vercel) |
| Variabel | `VERIFY_WORKER` | `true` där worker och janitor körs på Railway |
| Variabel | `RAILWAY_WORKER_SERVICE`, `RAILWAY_JANITOR_SERVICE` | tjänsternas namn på Railway, om de inte heter `worker` och `janitor` |
| Hemlighet | `VERCEL_DEPLOY_HOOK` | Vercel → Settings → Git → **Deploy Hooks**, en för grenen |
| Hemlighet | `RAILWAY_TOKEN` | Railway → projektet → Settings → **Tokens**, en projekttoken för miljön |
| Hemlighet | `VERCEL_BYPASS` | bara om miljön ligger bakom Vercels inloggning: Settings → Deployment Protection → **Protection Bypass for Automation** |

Blir steget rött för workern eller janitorn: titta på
[status.railway.com](https://status.railway.com) och tjänstens Deployments,
tryck **Redeploy** när Railway är uppe, och kör arbetsflödet igen
(Actions → Deploy → Run workflow) — migrationerna är redan gjorda och
körs om utan att något ändras.

---

## 9. Övervakning och om något går fel

- **Upptid**: `https://<din-domän>/api/health` svarar `{"ok":true,…}` när
  databasen svarar, och berättar om workern lever. Lägg in den i en gratis
  övervakare (UptimeRobot, Better Stack) med 5 minuters intervall.
- **Adminsidan** `/admin`: plattformsnyckelns kredit, poolen, workerns
  senaste körningar och de senaste 7 dygnens fel som ingen fångade (appen,
  workern, janitorn).
- **Loggar**: Railway (worker, janitor) och Vercel (Functions).
- **Backa**: Vercel → Deployments → *Instant Rollback*. Railway → tidigare
  deploy → *Redeploy*. Databasen går bara framåt: rätta med en ny migration.
  Supabase Pro har dagliga säkerhetskopior (Database → Backups).
