import { llmJson } from './llm.js';
import { verifyQuotes } from './score.js';
import { UPPGIFT } from './uppgifter.js';

// ------------------------------------------------------------
// The ad, read into the same shape as the CV.
//
// buildCvProfile turns a CV into structure: headline, seniority,
// experience, skills tagged by field, domains, languages, constraints.
// Ads never got that treatment — adEmbedText handed the embedder a
// title and 2000 characters of raw prose, and scoreAd read the same.
//
// Which means the two sides of every comparison had different shapes,
// and the ad's shape varied by SOURCE. Arbetsförmedlingen writes
// formal structured ads; a scraped Teamtailor page is marketing copy
// with the requirements buried in a paragraph about company culture; a
// hand-added lead has no text at all. The same job, described two
// ways, scored differently — and that is a format problem, not a model
// problem, so it belongs upstream of the model rather than being
// something each prompt has to cope with again.
//
// The vocabulary is deliberately the CV's, not a new one:
//
//   CV                          AD
//   seniority                   seniority          same enum
//   years_experience            years_required     same unit
//   skills[{name, field}]       requires[{name, field, weight}]
//   experience[].what           tasks[]
//   domains[]                   domains[]          same
//   languages[{name, level}]    languages[]        same
//   constraints[]               employment/location
//
// So "vård och omsorg" on one side meets "vård och omsorg" on the
// other, instead of a care requirement having to be inferred out of a
// wall of prose and compared against a skills list that reads as tech.
//
// `evidence` is verbatim from the ad, for the reason the CV's is
// (CLAUDE.md #5): a requirement the app cannot point at in the ad is a
// requirement it invented, and this is the text a letter will answer.
// ------------------------------------------------------------

const SYSTEM = `Du läser en jobbannons och extraherar vad ROLLEN KRÄVER, en gång, noggrant.

Detta blir underlaget för både matchning och bedömning, så formen måste bli
densamma oavsett om annonsen kommer från Arbetsförmedlingen, en Teamtailor-sida
eller är klistrad in för hand. Beskriv rollen — inte företagets kultur, inte
förmåner, inte hur roligt det är hos dem.

REGLER
- "evidence" MÅSTE vara ETT SAMMANHÄNGANDE ordagrant utdrag ur annonsen, max 20 ord.
  Klipp aldrig ihop delar med "...". Hittar du inget belägg: utelämna fakta.
- Hitta aldrig på krav. Står det inget om antal år är years_required null.
- Skilj KRAV från MERITERANDE. "Du ska ha" är krav, "det är ett plus om" är
  meriterande. Är det otydligt: meriterande.
- "field" ska vara yrkesområdet på vanlig svenska: "IT", "vård och omsorg",
  "restaurang", "bygg", "ekonomi", "utbildning", "lager och logistik",
  "handel", "transport", "administration". Samma ord på båda sidor är hela
  poängen — hitta inte på nya kategorier.
- seniority: student om det är praktik/LIA/exjobb, annars junior, mid eller senior.
- tasks är vad man faktiskt gör om dagarna, kort, i punkter.
- Marknadsföringsspråk är inte krav. "Vi erbjuder en dynamisk arbetsplats" ska
  inte bli någonting.
- Svenska, utom tekniknamn och egennamn.
- "kind" säger VILKEN SORTS krav det är. Det avgör hur tungt det väger senare,
  så var noga:
  - "yrke": själva yrket eller rollen ("legitimerad sjuksköterska", "elektriker")
  - "licens": legitimation, behörighet, certifikat, körkort, medborgarskap,
    säkerhetsprövning — sådant man antingen har eller inte har
  - "utbildning": examen eller utbildningsnivå
  - "erfarenhet": erfarenhet av ett område, eller antal år
  - "teknik": verktyg, system, programmeringsspråk, metoder
  - "språk": språkkunskaper
  - "egenskap": personliga egenskaper ("noggrann", "flexibel", "social",
    "stresstålig", "serviceinriktad"). Sådant står i nästan varje annons och
    går inte att belägga i ett CV — märk det rätt, gissa aldrig något annat.
- Skriv ALDRIG samma krav två gånger. Står språkkravet i "languages" ska det
  inte också ligga i "requires".
- HÖGST 12 krav totalt i "requires", de tyngsta först: yrke och licens, sedan
  utbildning och erfarenhet, sedan teknik. Slå ihop det som hör ihop
  ("HTML, CSS och JavaScript" är ETT krav, inte tre). En annons som listar
  tjugo saker kräver inte tjugo saker — den räknar upp en kravprofil, och en
  lista som är längre än tolv rader går varken att läsa eller väga.

Svara ENDAST med JSON, inga kodstaket:
{
  "headline": "en rad som beskriver rollen neutralt, t.ex. \\"Undersköterska till äldreboende, natt\\"",
  "role": {"title": "rolltiteln som annonsen använder", "field": "vård och omsorg"},
  "seniority": "student | junior | mid | senior",
  "years_required": tal eller null,
  "requires": [{"name": "körkort B", "field": "transport", "weight": "krav|meriterande", "kind": "licens", "evidence": "ordagrant ur annonsen"}],
  "tasks": [{"what": "kort mening", "evidence": "ordagrant ur annonsen"}],
  "domains": [{"name": "äldreomsorg", "evidence": "ordagrant"}],
  "languages": [{"name": "Svenska", "level": "flytande", "evidence": "ordagrant"}],
  "education_required": {"what": "…", "evidence": "ordagrant"} eller null,
  "employment": {"form": "tillsvidare|vikariat|behovsanställning|praktik|okänt", "extent": "heltid|deltid|okänt", "start": "text eller null"},
  "location": {"where": "ort eller null", "remote": "ja|delvis|nej|okänt"},
  "dealbreakers": ["krav som utesluter någon utan dem, kort — bara om annonsen är tydlig"]
}`;

// The fields that carry verbatim quotes, checked the same way the CV's
// are. A fact whose quote is not in the ad keeps the fact and loses the
// claim to evidence — the UI can then show it as unsourced rather than
// the app silently trusting it.
const CITERADE = ['requires', 'tasks', 'domains', 'languages'];

// ------------------------------------------------------------
// Too thin to grade on.
//
// The cheap model's failure is completeness, not fidelity (measured
// below), and paraphrase counts as thin: a requirement the user cannot
// find in the ad is the row this step exists to avoid. Only for ads long
// enough to hold more — a four-line ad with two requirements is not a
// failed read, it is a short ad.
//
// Returns the reason in the words the card shows, or null.
// ------------------------------------------------------------
export function tunnLäsning(p, text) {
  const antal = p?.requires?.length || 0;
  // Counted AFTER the quote check, not before. The cheap model fills the
  // evidence field almost every time — it just does not always quote:
  // asked for the ad's words it writes its own, and 89 of 268 rows lost
  // their quote at verification.
  const belagda = (p?.requires || []).filter((r) => r.verbatim).length;
  if (text.length <= 1200 || (antal >= 4 && belagda >= antal * 0.6)) return null;
  return `${antal} krav, varav ${belagda} med ordagrant citat, i en annons på ${text.length} tecken`;
}

// profileId: whose key pays for the read — the user grading the ad.
// läsare is the model call, injectable so the proof can run without one.
//
// The result carries how it went: __tom when there was nothing to read,
// __otillförlitlig (the reason) when even the better model's read was
// too thin to trust. The caller stores both and grades neither.
export async function buildAdProfile(ad, { profileId, läsare = llmJson } = {}) {
  const text = [
    ad.title,
    ad.raw?.occupation?.label,
    ad.employer,
    ad.municipality,
    ad.raw?.working_hours_type?.label,
    ad.raw?.employment_type?.label,
    ad.description,
  ].filter(Boolean).join('\n');

  if (!text.trim() || (ad.description || '').trim().length < 40) {
    // A hand-added lead has no ad text. Nothing to read, and a model
    // asked to read nothing invents a role — so this returns the little
    // that is actually known and says so.
    return {
      headline: ad.title || ad.employer || 'Okänd roll',
      role: { title: ad.title || null, field: null },
      seniority: null,
      years_required: null,
      requires: [], tasks: [], domains: [], languages: [],
      education_required: null,
      employment: { form: 'okänt', extent: 'okänt', start: null },
      location: { where: ad.municipality || null, remote: 'okänt' },
      dealbreakers: [],
      __tom: true,
    };
  }

  // Cheap first, expensive only when the cheap read came back thin.
  //
  // Measured on six ads, same prompt: gemini-2.5-flash costs $0.0047 an
  // ad and quotes 99% verbatim; gemini-2.5-flash-lite costs $0.0007 —
  // seven times less — and quotes 98%. The difference is not fidelity,
  // it is COMPLETENESS: the lite model found 43 requirements where
  // flash found 73, and on one ad it listed 4 where flash listed 18.
  //
  // A missing requirement is the failure that matters here: the
  // checklist would be judged complete while the ad's actual demands
  // were never on it. So the cheap read stands only when it comes back
  // complete AND sourced, and anything thinner is re-read by the better
  // model. (gpt-oss-120b was measured too: 58s an ad, two broken JSON
  // answers out of six, 83% verbatim. Not a candidate.)
  let usedModel = null;

  // verifyQuotes reads `quote`; these facts carry theirs in `evidence`.
  // Passed straight in, every check returned verbatim:false — the flag
  // was written but nothing ever set it true, so renderAdProfile
  // printed no evidence at all. cvprofile.js maps the field first,
  // which is why the CV side worked and this did not.
  const kontrollera = (p) => {
    for (const key of CITERADE) {
      p[key] = verifyQuotes(
        (p[key] || []).map((f) => ({ ...f, quote: f.evidence })), text
      ).map(({ quote, ...f }) => f);
    }
    return p;
  };

  const läs = async (tier) => kontrollera(await läsare({
    profileId,
    uppgift: UPPGIFT.LÄSA_KRAV,
    koppling: { adId: ad.id },
    onModel: (m) => { usedModel = m; },
    tier,
    // Long ads truncated the JSON at 2500 and the whole read was lost.
    maxTokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: text.slice(0, 9000) }],
  }));

  let p = await läs('fast');
  const tunt = tunnLäsning(p, text);
  if (tunt) {
    console.log(`  annonsprofil: ${tunt} — läser om`);
    p = await läs('bulk');
    // The better model's read was never checked: a still-thin read was
    // stored and graded anyway, and the grade then judged the CV against
    // a list that was missing most of what the ad asked for. Now it
    // stops here, before anything is spent on grading it.
    const fortfarandeTunt = tunnLäsning(p, text);
    if (fortfarandeTunt) p.__otillförlitlig = fortfarandeTunt;
  }
  p.__model = usedModel;
  return p;
}

// ------------------------------------------------------------
// Render, in the same sectioned shape renderCvProfile produces.
//
// This is the half that makes the embedding symmetric: the vector for
// an ad is built from "## ROLL / ## KRAV / ## UPPGIFTER" and the vector
// for a search from "## KANDIDAT / ## ERFARENHET / ## KOMPETENSER", so
// the two land in the same region of the space for the same reasons
// rather than because two prose styles happened to share vocabulary.
// ------------------------------------------------------------
export function renderAdProfile(p, { medBelagg = false } = {}) {
  if (!p) return null;

  const krav = (p.requires || []).filter((r) => r.weight !== 'meriterande');
  const plus = (p.requires || []).filter((r) => r.weight === 'meriterande');

  // With evidence when a caller needs it quotable. Asked to reason from
  // a summary, the scoring model quoted the summary — 0 of 2 matched
  // quotes were verbatim in the ad, which silently breaks the
  // highlighting invariant. Printing each requirement beside the words
  // the ad used means a quote lifted from here is verbatim by
  // construction, because verifyQuotes already checked it at build
  // time.
  //
  // Off for embedding: a vector wants the shape, and the evidence is
  // the same prose the shape exists to abstract away from.
  const lista = (rs) => rs.map((r) => `${r.name}${r.field ? ` [${r.field}]` : ''}`
    + (medBelagg && r.verbatim && r.evidence ? `\n    ur annonsen: "${r.evidence}"` : ''))
    .join(medBelagg ? '\n  - ' : ', ');

  return [
    `## ROLL
${p.headline || p.role?.title || ''}${p.role?.field ? ` [${p.role.field}]` : ''}`
      + `${p.seniority ? ` — ${p.seniority}` : ''}`
      + `${p.years_required ? `, ${p.years_required} års erfarenhet krävs` : ''}`,

    krav.length && `## KRAV
${medBelagg ? '  - ' : ''}${lista(krav)}`,
    plus.length && `## MERITERANDE
${medBelagg ? '  - ' : ''}${lista(plus)}`,

    p.tasks?.length && `## UPPGIFTER
${p.tasks.map((t) => `- ${t.what}`).join('\n')}`,

    p.domains?.length && `## DOMÄNER
${p.domains.map((d) => d.name).join(', ')}`,
    p.education_required?.what && `## UTBILDNING
${p.education_required.what}`,
    p.languages?.length && `## SPRÅK
${p.languages.map((l) => `${l.name}${l.level ? ` (${l.level})` : ''}`).join(', ')}`,

    (p.employment?.form !== 'okänt' || p.employment?.extent !== 'okänt') && `## ANSTÄLLNING
${[p.employment?.form, p.employment?.extent, p.employment?.start].filter((x) => x && x !== 'okänt').join(', ')}`,

    p.location?.where && `## PLATS
${p.location.where}${p.location.remote && p.location.remote !== 'okänt' ? ` (distans: ${p.location.remote})` : ''}`,

    p.dealbreakers?.length && `## UTESLUTER UTAN
${p.dealbreakers.join('; ')}`,
  ].filter(Boolean).join('\n\n');
}
