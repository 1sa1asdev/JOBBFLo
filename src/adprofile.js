import { pool } from './db.js';
import { llmJson } from './llm.js';
import { verifyQuotes } from './score.js';

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

Svara ENDAST med JSON, inga kodstaket:
{
  "headline": "en rad som beskriver rollen neutralt, t.ex. \\"Undersköterska till äldreboende, natt\\"",
  "role": {"title": "rolltiteln som annonsen använder", "field": "vård och omsorg"},
  "seniority": "student | junior | mid | senior",
  "years_required": tal eller null,
  "requires": [{"name": "körkort B", "field": "transport", "weight": "krav|meriterande", "evidence": "ordagrant ur annonsen"}],
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

export async function buildAdProfile(ad) {
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
      __thin: true,
    };
  }

  let usedModel = null;
  const p = await llmJson({
    onModel: (m) => { usedModel = m; },
    // Same tier as scoring: this replaces work scoreAd was doing on raw
    // text anyway, and it is done once per ad instead of once per
    // (ad × search × criteria change).
    tier: 'bulk',
    maxTokens: 2500,
    system: SYSTEM,
    messages: [{ role: 'user', content: text.slice(0, 9000) }],
  });

  for (const key of CITERADE) {
    p[key] = verifyQuotes(p[key] || [], text);
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

// ------------------------------------------------------------
// Fill profiles in, newest and most-wanted first.
//
// Not all at once: the bulk tier is a free Groq model with a request
// ceiling, so 36,000 ads is weeks of calls rather than an afternoon.
// Ads that are candidates in a search come first, because those are the
// ones anything actually reads; the rest fill in behind them and the
// embedding improves as they do.
// ------------------------------------------------------------
export async function buildPendingAdProfiles({ limit = 20 } = {}) {
  const { rows: ads } = await pool.query(
    `SELECT a.id, a.title, a.employer, a.municipality, a.description, a.raw,
            (SELECT count(*) FROM match_results m WHERE m.ad_id = a.id) AS i_sokningar
     FROM ads a
     WHERE a.ad_profile IS NULL
       AND a.removed_at IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
     ORDER BY (SELECT count(*) FROM match_results m WHERE m.ad_id = a.id) DESC,
              a.published_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  if (!ads.length) return { done: 0, thin: 0 };

  let done = 0; let thin = 0;
  for (const ad of ads) {
    try {
      const p = await buildAdProfile(ad);
      await pool.query(
        `UPDATE ads SET ad_profile = $2::jsonb, ad_profile_at = now(),
           ad_profile_model = $3,
           -- Only when the profile is what gets embedded. Clearing it
           -- unconditionally would throw away a good vector and buy the
           -- same one back, 37,000 times, for nothing.
           embedding = CASE WHEN $4 THEN NULL ELSE embedding END
         WHERE id = $1`,
        [ad.id, JSON.stringify(p), p.__model || (p.__thin ? 'tunn' : null),
         process.env.EMBED_FROM_PROFILE === '1']
      );
      if (p.__thin) thin += 1; else done += 1;
    } catch (err) {
      // Left NULL and retried later. A profile that cannot be built
      // must not block the ad from being found, scored or sent to —
      // everything downstream already handles its absence.
      console.error(`ad-profil ${ad.id}: ${String(err.message).slice(0, 90)}`);
    }
  }
  return { done, thin, kvar: await antalUtanProfil() };
}

export async function antalUtanProfil() {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM ads
     WHERE ad_profile IS NULL AND removed_at IS NULL
       AND (deadline IS NULL OR deadline >= current_date)`
  );
  return r.n;
}
