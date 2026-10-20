# Plan: Gemensam pool, personliga uppgifter

*Genomförd (del 4b-1) på grenen `feat/shared-pool`. Testresultat längst ned.*

## Mål

Annonspoolen är gemensam, men det användare *gör* med en annons ska vara deras eget. I dag skrivs fyra sorters personliga uppgifter rakt in i den gemensamma poolen, och då kan en användare påverka, eller se, vad en annan gör.

## Vad granskningen hittade

| Hål | Följd |
|---|---|
| **Manuellt tillagda annonser** (`autoapply/lead`, `/lead/bulk`) hamnar i den gemensamma poolen, och sökningen filtrerar inte bort dem | användare A:s annons, med en mejladress A har skrivit in, kan matchas i användare B:s kampanj. **B:s CV skickas då till A:s adress.** |
| **Inskrivna mejladresser** (`autoapply/leads` PATCH) sparas på den gemensamma annonsen. Klienten bestämmer själv om adressen räknas som "skannad". | samma risk: vem som helst kan sätta en adress som alla andras kampanjer sedan skickar till |
| **"Visa aldrig"** (`never_apply`) har ingen ägare | A:s bortval döljer annonsen för alla |
| **"Länken öppnad"** (`ads.apply_url_opened_at`) har ingen ägare | A:s klick markerar annonsen som öppnad för alla |
| **Dubbletter** (`findDuplicates`) | visar andra användares ansökningsstatus på dubblettannonser, och andras privata annonser |

## Uppdelning

| PR | Innehåll |
|---|---|
| **4b-1 (den här)** | Manuella annonser privata. "Visa aldrig", "länken öppnad" och dubbletter per användare. |
| 4b-2 (nästa) | Inskrivna mejladresser per användare. Adresser delas bara när servern själv läst dem från arbetsgivarens sida. |

4b-2 är separat eftersom mejladressen läses på cirka 20 ställen i kampanjlogiken, inklusive själva utskicket. Det är pengar och rykte, och förtjänar sin egen PR och sitt eget bevis.

## Ändringar (4b-1)

### Migration 047: annonser med ägare
- `ads.owner_profile_id`, som är tomt för poolens egna annonser (flödet och snapshoten) och satt för en annons som en användare lagt till själv. Tas användaren bort, tas dennes annonser bort.
- **Sökningen ser bara poolen plus användarens egna annonser.** Villkoret "öppen annons" i `src/localsearch.js` får ägaren som parameter. Det gäller sökning, antal och filterförslag.
- **`ads/[id]` och alla routes som tar ett annons-id** (`applied`, `opened`, `leads`) svarar 404 på en annan användares privata annons.

### Migration 048: "visa aldrig" per användare
- `never_apply` får `profile_id`. Primärnyckeln blir (användare, fingeravtryck).
- Dina befintliga bortval flyttas till din profil.
- Läses i sökningens poolfilter, i bedömningskön (`score.js`) och i vyn `search_results`, som skrivs om så att flaggan "dold" gäller sökningens ägare.

### Migration 049: "länken öppnad" per användare
- En ny tabell `ad_opens(profile_id, ad_id, opened_at)`.
- Dina befintliga markeringar flyttas dit, och kolumnen på `ads` tas bort.
- Läses i sökresultaten ("✓ Sökt").

### Dubbletter
- `findDuplicates(adId, profileId)` visar bara den egna ansökningsstatusen, och aldrig andras privata annonser.

### Bevis
- `scripts/prove-owner-checks.js` utökas, med samma två inloggade användare:
  - **A:s manuella annons hittas inte av B:s sökning,** inte ens med exakt matchande kriterier. B kan inte heller öppna den via id.
  - **A:s "visa aldrig" döljer inget för B.**
  - **A:s "länken öppnad" syns inte för B.**
  - **B ser inte A:s ansökan på en dubblett.**
- **Kontroll mot den gamla koden först,** som förra gången, så att beviset bevisligen fångar hålen.

## Test innan PR:en öppnas
1. Migrationerna, `db:schema`, `db:check`, och `db:check --live` mot din databas.
2. Beviset med två användare, mot den gamla koden (ska bli rött) och mot den nya (ska bli grönt).
3. Med din profil: dina manuella annonser, bortval och öppnade länkar finns kvar och fungerar som förut.
4. Alla bevis och produktionsbygget gröna lokalt och i CI.

## Testresultat (20 okt)

**Beviset med två inloggade användare**, utökat med poolfallen och kört mot en produktionsbyggd server med inloggning:

| | Gammal kod | Ny kod |
|---|---|---|
| B:s sökning hittar A:s egna annons, så B:s CV kan skickas till A:s adress | **ja** | nej |
| A:s "visa aldrig" döljer annonsen för B | **ja** | nej |
| B kan öppna A:s privata annons | **ja (200)** | nej (404) |
| A:s "länken öppnad" påverkar B | **ja** | nej |
| B ser A:s ansökan på en dubblett | **ja (status "sent")** | nej |
| A ser sina egna annonser och sina egna bortval | ja | ja |

Alla 24 kontroller är gröna med den nya koden.

- **Mot din databas:** migrationerna flyttade alla 40 manuella annonser till din profil, alla 40 bortval och din öppnade länk. Resultat med avstånd, filterförslag, din egen manuella annons, dubbletter, kampanjer, dashboard och inkorg svarar som förut. `db:check --live` är grön.
- **CI-spärren** kräver nu att även annons-routes, och alla routes som tar ett `adId`, kontrollerar synligheten.

### Upptäckt på vägen
- **Sökresultaten svarade 500 för varje användare utan hemort,** alltså varje ny användare. Radfrågan skickade alltid med latitud och longitud, men använde dem bara när en hemort fanns. Det är fjärde gången samma felklass dyker upp i den filen, så parameterindexen härleds nu i stället för att hårdkodas. Du har en hemort och såg det därför aldrig. Beviset med två användare hittade det, eftersom testanvändaren saknar hemort.
- **Sökresultaten kopplade allas ansökningar** på en annons, så B:s lista kunde visa att A hade ett brev eller hade sökt. Den kopplingen är nu avgränsad till sökningens ägare.
