# Plan: Annonsläsning per användare + spärr för tunna läsningar (PR 3b)

*Genomfört 20 okt som steg 1 av lanseringsgrenen `feat/per-user-ad-reads`. Migration 052 är körd lokalt efter en säkerhetskopia (`jobbflo-20261020-1637-fore-052.dump`): 692 läsningar och 1 585 checklistor ligger nu på din profil.*

## Mål

Varje användare läser annonsernas krav själv, med sin egen modell, på sin egen nyckel. Ingenting en användare läser eller bedömer påverkar en annan användares checklista. En läsning som inte håller stoppas innan pengar läggs på att bedöma den.

## Beslut (19 okt)

- **Läsningen är isolerad per användare.** Att dela den avvisades som orättvist, eftersom den som läser först betalar för alla.
- **Läsning och bedömning förblir två steg.** Mellanrummet mellan dem är en kvalitetsspärr.
- **Dubbla läsningar mellan användare är okej** ($0.0007–0.0047 per annons) och syns i varje användares kostnad.

## Läget i dag (kontrollerat)

| Del | I dag | Problem med flera användare |
|---|---|---|
| **Läsningen** (`ads.ad_profile`) | en kolumn på annonsen, gemensam för alla | A läser och betalar, och B får A:s läsning, gjord med A:s modell. Byter A modell ändras inget för B, och tvärtom. |
| **Cachen för checklistor** (`ad_checks`) | nyckel (annons, hash av CV + kampanjregel) | ingen användare i nyckeln. Två användare med samma CV-text delar checklista, och checklistan bygger på någon annans läsning. |
| **Andra vektorn** (`ads.profile_embedding`) | workern bäddar in läsningen med **plattformens** nyckel | du betalar för att bädda in en användares läsning. Ingenting rankar på den: båda ställena som kunde använda den säger uttryckligen att den inte används (`results/route.js`, `autoapply.js`). |
| **`EMBED_FROM_PROFILE=1`** | experimentflagga: annonsens delade vektor byggs från läsningen | skulle göra den delade poolen beroende av en användares läsning. Avstängd i dag. |
| **Tunn läsning** (`buildAdProfile`) | billig läsning först, och om den är tunn läses annonsen om med den bättre modellen | ingen kontrollerar omläsningen. Är den också tunn sparas den och bedöms ändå, så pengar läggs på en checklista över fel krav. |
| **Annons utan text** (handinlagt tips) | tom kravlista, och bedömningen säger "Annonsen anger inga krav" | det stämmer inte. Annonsen har ingen text, inte inga krav. |
| **`buildPendingAdProfiles`** | bakgrundsläsaren | död kod sedan PR 3a tog bort timern. |

Siffror från din databas: 692 läsningar (384 med flash-lite, 308 med flash), 1 337 profilvektorer och 1 585 checklistor över 4 CV-nycklar.

## Ändringar

### Migration 052: läsningar och checklistor per användare
- **Ny tabell `ad_reads`** med kolumnerna `ad_id`, `profile_id`, `model`, `status` (`ok` | `misslyckad` | `tom`), `profile` (jsonb), `reason`, `read_at` och primärnyckeln **(annons, användare)**.
- **De 692 läsningarna flyttas till din profil,** om det finns exakt en profil, på samma sätt som migration 051.
- **`ad_checks` får `profile_id`,** och primärnyckeln blir (annons, användare, CV-nyckel). Dina 1 585 checklistor flyttas till din profil.
- **Bort tas** `ads.ad_profile`, `ad_profile_at`, `ad_profile_model`, `profile_embedding` och `profile_embedded_at`. Det som behövs från dem finns i `ad_reads`.

### Läsningen: `kravFörAnnons(ad, profileId)`
- Letar bara bland **den användarens** läsningar. Finns ingen läser användaren själv, och läsningen sparas på användaren.
- Workerns städning (`refresh.js`) raderar läsningarna för stängda annonser, i stället för att nollställa kolumnen.

### Spärren: en tunn läsning bedöms inte
1. Annonsen läses med den billiga modellen.
2. Är läsningen tunn läses den om med den bättre. Det är samma tröskel som i dag: en lång annons med färre än 4 krav, eller där under 60 % av kraven har ordagranna citat.
3. **Nytt:** är även omläsningen tunn sparas den som `misslyckad`, med orsaken i klartext, till exempel *"2 krav, varav 1 med citat, i en annons på 4 300 tecken"*. **Ingen bedömning görs.** Kortet visar *"Annonsen kunde inte läsas tillförlitligt"* och orsaken.
4. En misslyckad läsning **läses inte om automatiskt.** Annars skulle kön betala för två läsningar per försök, tre försök i rad. Den läses om när användaren trycker på "Bedöm igen".
5. **Annons utan text:** sparas som `tom`, utan anrop och utan kostnad. Kortet visar *"Annonsen har ingen text att läsa"* i stället för "anger inga krav".

### Cachen för checklistor: per användare
- Uppslag och sparande i `ad_checks` sker per (annons, användare, CV). Två användare med samma CV får var sin checklista, byggd på var sin läsning.

### Bort: profilvektorn och den döda bakgrundsläsaren
- `embedPendingProfiles` och tick-steget i workern tas bort, och flaggan `EMBED_FROM_PROFILE` likaså. Plattformen bäddar bara in annonsens egen text, som den redan gör för poolen.
- `buildPendingAdProfiles` och `antalUtanProfil` tas bort.
- Forskningsskripten (`check-adprofile`, `compare-embeddings`, `compare-multivector`, `prove-adprofile`) läser från `ad_reads` för en angiven profil.

## Bevis: `scripts/prove-ad-reads.js` (i CI, utan modellanrop)

Läsaren och bedömaren byts mot låtsasversioner som räknar anrop, så att beviset inte kostar något och inte behöver en nyckel.

1. **A bedömer annons X:** A:s läsare anropas och läsningen sparas på A.
2. **B bedömer X:** B:s läsare anropas, B får inte A:s läsning, och A:s läsning är orörd.
3. **Samma CV-text hos A och B** ger två checklistor, inte en delad.
4. **Billig läsning tunn, omläsning bra:** annonsen bedöms.
5. **Båda läsningarna tunna:** bedömaren anropas **inte**, läsningen sparas som misslyckad och orsaken syns.
6. **Ett nytt försök i kön** läser inte om (noll anrop). "Bedöm igen" läser om.
7. **Annons utan text:** noll anrop, och svaret säger "ingen text".
8. **Stängd annons:** dess läsningar raderas.

Beviset körs mot den gamla koden först, som förut, och ska bli rött där.

## Utanför den här PR:en
- Kostnadsuppskattningen i onboarding, som räknar med läsningen per användare.
- Val av läsmodell i onboarding. Läsningen använder fortfarande användarens nivåer "Snabb" och "Bedömning".

## Beslut om frågorna (20 okt)
1. **Nyckel per (annons, användare), utan modell:** enligt rekommendationen.
2. **Profilvektorn är borttagen:** enligt rekommendationen.

## Vad som hände under bygget
- **Beviset var rött mot den gamla koden** i 13 av 15 kontroller.
- **Annonssidan skickade `a.*` till webbläsaren,** alltså även den delade läsningen. Kolumnen finns inte längre, och beviset för ägarkontroller kontrollerar nu också att B:s läsning inte syns för A.
- **Ett misslyckat kort hade ingen knapp.** Kort som misslyckats tre gånger saknade väg tillbaka. Nu finns "Försök igen →", som nollställer försöken och läser om en annons som inte kunde läsas.
