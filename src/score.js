import { pool } from './db.js';
import { llmJson } from './llm.js';
import { buildProfileTerms, prefilterAd } from './prefilter.js';

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

VIKTIGT — sätt ALLTID occupation-field om yrket hör hemma i ett tydligt område.
Utan det returnerar API:t annonser från alla branscher (svetsare, barnskötare,
säljare) som sedan kostar en dyr bedömning var. Ett fält är nästan alltid
härledbart: "frontendutvecklare" → Data/IT, "restaurangbiträde" → Hotell,
restaurang, storhushåll, "undersköterska" → Hälso- och sjukvård.
Utelämna det bara när kandidaten uttryckligen söker brett över flera branscher
(t.ex. "vilket extrajobb som helst").

VIKTIGT — filter som oftast ger noll träffar, använd dem nästan aldrig:
- remote: sätt ENDAST om kandidaten kräver helt distansarbete. "Hybrid är okej",
  "kan pendla", "helst distans" är önskemål → lägg i "unmapped", inte som filter.
- employment-type och experience-required: utelämna om det inte är ett uttryckligt krav.
Ett tomt sökresultat är värre än ett brett — hellre 200 annonser att bedöma än 0.`;

export async function parseCriteria(criteriaText) {
  return llmJson({
    tier: 'bulk',
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

// Requirements live in the first half of an ad; the tail is usually
// benefits, company boilerplate and application instructions. Capping
// keeps the long tail (p99 is 6190 chars) from eating a free tier's
// per-minute budget. Safe for the verbatim-quote invariant: the model
// can only quote what it was shown, and that text is a prefix of what
// the UI highlights.
const AD_CHARS_MAX = 4200;   // ≈ p75, so most ads are untouched

function adTextForScoring(description) {
  const text = String(description || '');
  if (text.length <= AD_CHARS_MAX) return text;
  const cut = text.slice(0, AD_CHARS_MAX);
  const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  return `${cut.slice(0, lastBreak > AD_CHARS_MAX * 0.6 ? lastBreak : AD_CHARS_MAX)}\n\n[…annonsen fortsätter]`;
}

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

${adTextForScoring(ad.description)}`;

  return llmJson({
    tier: 'bulk',
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

// shared by the queue and the drain: a search may carry its own
// tailored CV, falling back to the profile's
async function loadSearchContext(searchId, { needCv = true } = {}) {
  const { rows: [search] } = await pool.query(
    `SELECT s.*, COALESCE(s.cv_text, p.cv_text) AS cv_text, p.about_text
     FROM searches s JOIN profile p ON p.id = s.profile_id
     WHERE s.id = $1`, [searchId]
  );
  if (!search) throw new Error(`no search ${searchId}`);
  if (needCv && !search.cv_text?.trim()) {
    throw new Error('Inget CV inlagt — ladda upp ett CV innan annonser kan bedömas.');
  }
  const { rows: projects } = await pool.query(
    `SELECT id, name, summary, tech FROM projects
     WHERE profile_id = $1 AND is_active`, [search.profile_id]
  );
  return { search, projects };
}

// ------------------------------------------------------------
// QUEUE — the fast half of a scan. Everything here is free:
// one Arbetsförmedlingen call plus local prefiltering, no LLM.
// It writes a match_results row per surviving candidate with
// score NULL, which is what lets the UI list the jobs about a
// second after the user asks instead of after the whole batch
// has been judged.
//
// The prefilter runs HERE rather than at scoring time on purpose:
// it drops ~95% of what the API returns, and queueing those would
// mean showing the user hundreds of ads that silently vanish once
// a model got to them.
// ------------------------------------------------------------
export async function queueSearch(searchId, { fetchLimit = 50, limit = 20 } = {}) {
  const { search } = await loadSearchContext(searchId);

  const { backfillSearch } = await import('./fetchJobs.js');
  const adIds = await backfillSearch(search.api_filters || {}, fetchLimit);

  // Restricted to the ads layer 1 actually selected for THIS search.
  // Without that restriction we'd queue the newest ads in the whole
  // global pool (every job in Sweden), which is exactly what layer
  // 1's cheap narrowing exists to prevent. Ads stay global; only the
  // candidate set is per-search.
  // apply_filter is enforced HERE, before anything is queued, because
  // the saving is the scoring call itself. Filtering the list at
  // display time would look the same and cost the same as no filter.
  const { rows: ads } = await pool.query(
    `SELECT a.* FROM ads a
     LEFT JOIN match_results m ON m.ad_id = a.id AND m.search_id = $1
     LEFT JOIN never_apply na ON na.fingerprint = a.fingerprint
     WHERE m.id IS NULL
       AND a.removed_at IS NULL
       AND na.fingerprint IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
       AND ($2::uuid[] IS NULL OR a.id = ANY($2))
       AND CASE $3::text
             WHEN 'email'    THEN a.apply_email IS NOT NULL
             WHEN 'external' THEN a.apply_email IS NULL AND a.apply_url IS NOT NULL
             ELSE true
           END
     ORDER BY a.published_at DESC NULLS LAST`,
    [searchId, adIds, search.apply_filter || 'any']
  );

  const profileTerms = buildProfileTerms({
    criteriaText: search.criteria_text, cvText: search.cv_text,
    apiFilters: search.api_filters || {},
  });
  const triaged = ads.map((ad) => ({ ad, ...prefilterAd(ad, profileTerms) }));
  const candidates = triaged.filter((t) => t.keep).sort((a, b) => b.score - a.score);
  const skipped = triaged.filter((t) => !t.keep);

  if (skipped.length) {
    console.log(`  förfilter: hoppar över ${skipped.length} av ${ads.length} (${skipped.slice(0, 3).map((s) => s.reason).join(', ')}…)`);
  }
  if ((search.apply_filter || 'any') !== 'any') {
    console.log(`  ansökningssätt: ${search.apply_filter} — bortfiltrerade innan bedömning`);
  }

  // queue_rank carries the prefilter's confidence so the drain can
  // judge the most promising ads first — on a slow model the user
  // watches the list fill from the top, not in arrival order.
  let queued = 0;
  for (const { ad, score } of candidates.slice(0, limit)) {
    const { rowCount } = await pool.query(
      `INSERT INTO match_results (search_id, ad_id, queue_rank)
       VALUES ($1, $2, $3)
       ON CONFLICT (search_id, ad_id) DO NOTHING`,
      [searchId, ad.id, score]
    );
    queued += rowCount;
  }

  await pool.query(`UPDATE searches SET last_scanned_at = now() WHERE id = $1`, [searchId]);
  console.log(`queued ${queued} ads for "${search.name}" (${skipped.length} förfiltrerade)`);
  return { queued, skipped: skipped.length, seen: ads.length };
}

// ------------------------------------------------------------
// DRAIN — the slow half. Judges queued ads best-first, writing
// each score the moment it arrives so the UI fills in one card at
// a time rather than all at once at the end.
//
// Failures increment `attempts` instead of vanishing: one ad the
// model chokes on must not wedge the queue, and three strikes
// leaves a visible "kunde inte bedömas" rather than a silent hole.
// ------------------------------------------------------------
export const MAX_SCORE_ATTEMPTS = 3;

// Namespaced advisory lock so two drains can't judge the same queue
// at once. They genuinely overlap in normal operation: a scan kicks
// off its own drain while the worker's drainTick is already running,
// and both would send the same 20 ads to the model — double the
// tokens for one result, which on a free tier is the difference
// between finishing and hitting the daily cap.
const DRAIN_LOCK_NS = 8123473;

export async function scorePending(searchId, { limit = 20 } = {}) {
  const client = await pool.connect();
  try {
    const { rows: [l] } = await client.query(
      `SELECT pg_try_advisory_lock($1, hashtext($2::text)) AS got`,
      [DRAIN_LOCK_NS, searchId]
    );
    if (!l.got) return [];          // another drain owns this queue
    try {
      return await drainQueue(searchId, { limit });
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1, hashtext($2::text))`,
        [DRAIN_LOCK_NS, searchId]);
    }
  } finally {
    client.release();
  }
}

async function drainQueue(searchId, { limit }) {
  const { search, projects } = await loadSearchContext(searchId);

  const { rows: ads } = await pool.query(
    `SELECT a.* FROM match_results m
     JOIN ads a ON a.id = m.ad_id
     LEFT JOIN never_apply na ON na.fingerprint = a.fingerprint
     WHERE m.search_id = $1
       AND m.score IS NULL
       AND m.attempts < $3
       AND a.removed_at IS NULL
       AND na.fingerprint IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
     ORDER BY m.queue_rank DESC NULLS LAST, a.published_at DESC NULLS LAST
     LIMIT $2`,
    [searchId, limit, MAX_SCORE_ATTEMPTS]
  );

  if (!ads.length) return [];
  console.log(`scoring ${ads.length} queued ads for "${search.name}"`);
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

      // UPDATE, not INSERT: the row already exists from the queue
      // step. UNIQUE(search_id, ad_id) still means one row per pair.
      await pool.query(
        `UPDATE match_results SET
           score = $3, summary = $4, matched = $5, flags = $6,
           lead_project_id = $7, scored_at = now(), last_error = NULL
         WHERE search_id = $1 AND ad_id = $2`,
        [searchId, ad.id, r.score, r.summary,
         JSON.stringify(r.matched), JSON.stringify(r.flags),
         leadProject?.id || null]
      );

      results.push({ ad, ...r });
      console.log(`  ${String(r.score).padStart(3)} · ${ad.title} — ${ad.employer}`);
    } catch (err) {
      await pool.query(
        `UPDATE match_results SET attempts = attempts + 1, last_error = $3
         WHERE search_id = $1 AND ad_id = $2`,
        [searchId, ad.id, err.message]
      );
      console.error(`  !! ${ad.title}: ${err.message}`);
    }
  }
  return results;
}

// ------------------------------------------------------------
// One scan = layer 1 (narrow via the API, queue) then layer 2
// (judge what came back). The two must be chained: scoring a
// candidate set layer 1 didn't produce is what makes the funnel
// leak.
//
// Callers that can afford to wait (the worker, scripts/tryit) get
// the full synchronous run. Request handlers pass background:true
// to return as soon as the ads are queued and let the drain
// continue after the response — the whole point of the split.
// ------------------------------------------------------------
export async function scanSearch(searchId, { limit = 20, fetchLimit = 50, background = false } = {}) {
  const queue = await queueSearch(searchId, { fetchLimit, limit });

  if (background) {
    // deliberately not awaited; failures are logged, not thrown at
    // a response that has already been sent
    scorePending(searchId, { limit })
      .catch((e) => console.error(`bakgrundsbedömning ${searchId}:`, e.message));
    return queue;
  }

  const scored = await scorePending(searchId, { limit });
  return { ...queue, scored: scored.length, results: scored };
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
       AND m.score IS NOT NULL   -- unjudged is not the same as low
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
