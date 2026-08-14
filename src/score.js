import { pool } from './db.js';
import { llmJson } from './llm.js';

// ------------------------------------------------------------
// LAYER 1 — natural language -> structured API filters.
// Cheap server-side narrowing. Runs once per search, not per ad.
// ------------------------------------------------------------
const FILTER_SYSTEM = `Du översätter en jobbsökandes egna ord till filter för Arbetsförmedlingens JobSearch API.

Tillgängliga filter:
- q (fritext — yrkesord, teknik, nyckelord)
- occupation-field: EXAKT ett av dessa värden, annars utelämna:
  Administration, ekonomi, juridik | Bygg och anläggning | Chefer och verksamhetsledare |
  Data/IT | Försäljning, inköp, marknadsföring | Hantverk | Hotell, restaurang, storhushåll |
  Hälso- och sjukvård | Industriell tillverkning | Installation, drift, underhåll |
  Kropps- och skönhetsvård | Kultur, media, design | Militära yrken | Naturbruk |
  Naturvetenskap | Pedagogik | Sanering och renhållning | Säkerhet och bevakning |
  Transport, distribution, lager | Yrken med social inriktning | Yrken med teknisk inriktning
- municipality: kommunnamn på svenska, t.ex. "Stockholm", "Göteborg", "Solna"
- region: länsnamn, t.ex. "Stockholms län"
- employment-type
- experience-required: true|false
- remote: true|false
- published-after (ISO-datum)

Svara ENDAST med JSON, ingen förklaring, inga kodstaket:
{"filters": {...}, "unmapped": ["kriterier som inte går att uttrycka som filter"]}

Det som hamnar i "unmapped" hanteras i ett senare steg mot annonstexten — var generös med vad du lägger där. Filtren ska vara BREDA: hellre för många träffar än att missa jobb.

VIKTIGT — filter som oftast ger noll träffar, använd dem nästan aldrig:
- remote: sätt ENDAST om kandidaten kräver helt distansarbete. "Hybrid är okej",
  "kan pendla", "helst distans" är önskemål → lägg i "unmapped", inte som filter.
- employment-type och experience-required: utelämna om det inte är ett uttryckligt krav.
Ett tomt sökresultat är värre än ett brett — hellre 200 annonser att bedöma än 0.`;

export async function parseCriteria(criteriaText) {
  return llmJson({
    tier: 'smart',
    maxTokens: 1000,
    system: FILTER_SYSTEM,
    messages: [{ role: 'user', content: criteriaText }],
  });
}

// ------------------------------------------------------------
// LAYER 2 — cross-reference the FULL ad text against the CV
// and the user's stated criteria. This is the part that catches
// what the taxonomy fields can't express.
//
// Returns quoted spans so the UI can highlight the ad and link
// letter claims back to the requirement they answer.
// ------------------------------------------------------------
const SCORE_SYSTEM = `Du bedömer hur väl en jobbannons matchar en specifik kandidat.

Du får: kandidatens CV, kandidatens egna ord om vad hen söker, kandidatens projekt, och hela annonstexten.

Bedöm mot BÅDE CV:t och kandidatens uttalade kriterier. Kriterierna väger tyngre än CV:t när de krockar — kandidaten vet vad hen vill ha.

Citat i "matched" och "flags" MÅSTE vara ordagranna utdrag ur annonstexten, max 15 ord, så att de kan markeras i gränssnittet. Hitta aldrig på citat.

Svara ENDAST med JSON, inga kodstaket:
{
  "score": 0-100,
  "summary": "en mening om varför, på svenska",
  "matched": [{"quote": "ordagrant ur annonsen", "why": "kort"}],
  "flags":   [{"quote": "ordagrant ur annonsen", "why": "kort", "tag": "kort etikett, t.ex. 'Docker' eller '5+ år'"}],
  "lead_project": "projektnamn som passar bäst att lyfta i brevet, eller null"
}

"flags" ska fånga allt som talar EMOT matchningen: teknik kandidaten saknar, erfarenhetskrav, språkkrav, pendling. Etiketten ("tag") aggregeras senare till en kompetensglapp-rapport — håll den kort och konsekvent.

Poängsättning:
90-100 = nästan perfekt, sök direkt
70-89  = god match, värd att söka
50-69  = möjlig, med reservationer
0-49   = svag match`;

export async function scoreAd({ ad, profile, projects, criteriaText }) {
  const projectList = projects
    .map((p) => `- ${p.name} (${p.tech.join(', ')}): ${p.summary}`)
    .join('\n');

  const input = `## KANDIDATENS CV
${profile.cv_text}

## OM KANDIDATEN, I EGNA ORD
${profile.about_text || '(inget angivet)'}

## KANDIDATENS PROJEKT
${projectList || '(inga)'}

## VAD KANDIDATEN SÖKER
${criteriaText}

## ANNONS
Titel: ${ad.title}
Arbetsgivare: ${ad.employer} (${ad.employer_type})
Ort: ${ad.municipality || '—'}
Sista ansökningsdag: ${ad.deadline || '—'}
${ad.ats_vendor ? `Ansökan via: ${ad.ats_vendor}` : ''}

${ad.description}`;

  return llmJson({
    tier: 'smart',
    maxTokens: 2000,
    system: SCORE_SYSTEM,
    messages: [{ role: 'user', content: input }],
  });
}

// ------------------------------------------------------------
// Enforce the verbatim-quote invariant. matched[].quote and
// flags[].quote drive ad-text highlighting; a paraphrased quote
// highlights nothing and the evidence link jumps nowhere — a
// silent UI break. Models comply ~93% of the time, so verify
// here instead of trusting: mark each quote `verbatim` so the UI
// can render non-matching ones as plain text, and keep the item
// (a flag's `tag` still feeds the skills-gap report).
// ------------------------------------------------------------
export function verifyQuotes(items, adText) {
  const hay = (adText || '').toLowerCase();
  return (items || []).map((it) => ({
    ...it,
    verbatim: Boolean(it?.quote && hay.includes(String(it.quote).toLowerCase())),
  }));
}

// ------------------------------------------------------------
// score every unscored ad for a search.
// ads are global; match_results are per-search — so an ad
// already scored for search A still gets scored for search B.
// ------------------------------------------------------------
export async function scoreSearch(searchId, { limit = 20, adIds = null } = {}) {
  const { rows: [search] } = await pool.query(
    `SELECT s.*, p.cv_text, p.about_text
     FROM searches s JOIN profile p ON p.id = s.profile_id
     WHERE s.id = $1`, [searchId]
  );
  if (!search) throw new Error(`no search ${searchId}`);

  const { rows: projects } = await pool.query(
    `SELECT id, name, summary, tech FROM projects
     WHERE profile_id = $1 AND is_active`, [search.profile_id]
  );

  // Unscored, not expired, not suppressed — restricted to the ads
  // layer 1 actually selected for THIS search. Without that
  // restriction we'd LLM-score the newest ads in the whole global
  // pool (every job in Sweden), which is exactly what layer 1's
  // cheap narrowing exists to prevent. Ads stay global; only the
  // scoring candidate set is per-search.
  const { rows: ads } = await pool.query(
    `SELECT a.* FROM ads a
     LEFT JOIN match_results m ON m.ad_id = a.id AND m.search_id = $1
     LEFT JOIN never_apply na ON na.fingerprint = a.fingerprint
     WHERE m.id IS NULL
       AND a.removed_at IS NULL
       AND na.fingerprint IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
       AND ($3::uuid[] IS NULL OR a.id = ANY($3))
     ORDER BY a.published_at DESC NULLS LAST
     LIMIT $2`, [searchId, limit, adIds]
  );

  console.log(`scoring ${ads.length} ads for "${search.name}"`);
  const results = [];

  for (const ad of ads) {
    try {
      const r = await scoreAd({
        ad,
        profile: { cv_text: search.cv_text, about_text: search.about_text },
        projects,
        criteriaText: search.criteria_text,
      });

      const leadProject = projects.find((p) => p.name === r.lead_project);
      r.matched = verifyQuotes(r.matched, ad.description);
      r.flags = verifyQuotes(r.flags, ad.description);

      await pool.query(
        `INSERT INTO match_results (search_id, ad_id, score, summary, matched, flags, lead_project_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (search_id, ad_id) DO UPDATE SET
           score = EXCLUDED.score, summary = EXCLUDED.summary,
           matched = EXCLUDED.matched, flags = EXCLUDED.flags,
           lead_project_id = EXCLUDED.lead_project_id, scored_at = now()`,
        [searchId, ad.id, r.score, r.summary,
         JSON.stringify(r.matched), JSON.stringify(r.flags),
         leadProject?.id || null]
      );

      results.push({ ad, ...r });
      console.log(`  ${String(r.score).padStart(3)} · ${ad.title} — ${ad.employer}`);
    } catch (err) {
      console.error(`  !! ${ad.title}: ${err.message}`);
    }
  }

  await pool.query(`UPDATE searches SET last_scanned_at = now() WHERE id = $1`, [searchId]);
  return results;
}

// ------------------------------------------------------------
// One scan = layer 1 (narrow via the API) then layer 2 (score
// what came back). The two must be chained: scoring a candidate
// set layer 1 didn't produce is what makes the funnel leak.
// Used by the worker, the "Skanna nu" route, and scripts/tryit.
// ------------------------------------------------------------
export async function scanSearch(searchId, { limit = 20, fetchLimit = 50 } = {}) {
  const { rows: [search] } = await pool.query(
    `SELECT * FROM searches WHERE id = $1 AND deleted_at IS NULL`, [searchId]
  );
  if (!search) throw new Error(`no search ${searchId}`);

  const { backfillSearch } = await import('./fetchJobs.js');
  const adIds = await backfillSearch(search.api_filters || {}, fetchLimit);
  return scoreSearch(searchId, { limit, adIds });
}

// ------------------------------------------------------------
// skills gap: the byproduct that makes this more than an
// application tool. Aggregates flag tags across every scored ad.
// ------------------------------------------------------------
export async function skillsGap(profileId, { minMentions = 3 } = {}) {
  const { rows } = await pool.query(
    `SELECT
       f->>'tag' AS tag,
       count(*) AS mentions,
       round(avg(m.score)) AS avg_score
     FROM match_results m
     JOIN searches s ON s.id = m.search_id AND s.profile_id = $1
     CROSS JOIN LATERAL jsonb_array_elements(m.flags) f
     WHERE f->>'tag' IS NOT NULL
     GROUP BY f->>'tag'
     HAVING count(*) >= $2
     ORDER BY count(*) DESC`,
    [profileId, minMentions]
  );
  return rows;
}

// ------------------------------------------------------------
// calibration: were the scores actually right?
// gated on sample size — percentages off 3 applications mislead.
// ------------------------------------------------------------
export async function calibration(profileId, { minSample = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT
       CASE WHEN m.score >= 80 THEN '80-100'
            WHEN m.score >= 60 THEN '60-79'
            ELSE '0-59' END AS band,
       count(*) AS applications,
       count(*) FILTER (WHERE app.status IN ('replied','interview')) AS responses
     FROM applications app
     JOIN ads a ON a.id = app.ad_id
     JOIN match_results m ON m.ad_id = a.id AND m.search_id = app.origin_search_id
     JOIN searches s ON s.id = m.search_id AND s.profile_id = $1
     WHERE app.status <> 'drafted'
     GROUP BY band ORDER BY band DESC`,
    [profileId]
  );

  const total = rows.reduce((n, r) => n + Number(r.applications), 0);
  if (total < minSample) {
    return { ready: false, total, needed: minSample };
  }
  return {
    ready: true,
    total,
    bands: rows.map((r) => ({
      band: r.band,
      applications: Number(r.applications),
      responses: Number(r.responses),
      rate: Math.round((Number(r.responses) / Number(r.applications)) * 100),
    })),
  };
}
