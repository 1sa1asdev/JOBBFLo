import { pool } from './db.js';
import { llmJson } from './llm.js';
import { buildProfileTerms, prefilterAd } from './prefilter.js';
import { renderCvProfile } from './cvprofile.js';

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
- worktime-extent: EXAKT "Heltid" eller "Deltid". Det är HÄR omfattning hör hemma.
  "deltid", "deltidsjobb", "extrajobb", "några timmar i veckan" → Deltid.
- employment-type: EXAKT ett av: Tillsvidareanställning | Tidsbegränsad anställning |
  Vikariat | Behovsanställning | Säsongsanställning.
  Detta är ANSTÄLLNINGSFORM, inte omfattning. Lägg ALDRIG "deltid" eller "heltid" här —
  API:t svarar då med noll träffar utan felmeddelande.
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
- Skriv aldrig engelska värden ("part-time", "permanent") — använd de svenska
  etiketterna ovan ordagrant.
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

  // Prefer the profile: the CV read once by the best model, structured,
  // and about a third the tokens of the raw text. Scoring is a matching
  // task — it wants facts, not prose — and a fixed reading means two ads
  // are judged against the same candidate rather than against whatever
  // the model happened to infer that call. Falls back to the raw CV
  // when no profile has been built yet.
  const candidateBlock = profile.cv_profile_rendered
    || `## KANDIDATENS CV
${profile.cv_text}`;

  const input = `${candidateBlock}

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
// Whitespace is normalised on BOTH sides before comparing. Source text
// carries hard line wraps — PDFs especially, but ad descriptions too —
// and a model quoting across one reproduces it with a space. That quote
// is faithful; a raw substring test calls it invented. Measured on one
// CV profile, this alone was 5 of 9 false rejections.
//
// Elision is still a failure: "…in .NET ... Completed" is not a quote,
// and normalising whitespace does not rescue it, which is correct.
const flatten = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function verifyQuotes(items, sourceText) {
  const hay = flatten(sourceText);
  return (items || []).map((it) => ({
    ...it,
    verbatim: Boolean(it?.quote && hay.includes(flatten(it.quote))),
  }));
}

// shared by the queue and the drain: a search may carry its own
// tailored CV, falling back to the profile's
async function loadSearchContext(searchId, { needCv = true } = {}) {
  const { rows: [search] } = await pool.query(
    `SELECT s.*, COALESCE(s.cv_text, p.cv_text) AS cv_text, p.about_text,
            COALESCE(s.cv_profile, p.cv_profile) AS cv_profile
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
export async function queueSearch(searchId, { fetchLimit = 100, limit = null, pages = 1 } = {}) {
  const { search } = await loadSearchContext(searchId);

  const { backfillSearch } = await import('./fetchJobs.js');

  // Walk the result set instead of re-reading page one. Each scan
  // advances the cursor; when it passes the reported total it wraps to
  // 0 so the next scan picks up newly published ads. Finding is free,
  // so paging deep costs one HTTP request per page and nothing else.
  let offset = search.fetch_offset || 0;
  let total = search.fetch_total ?? null;
  let dropped = [];
  const adIds = [];

  for (let page = 0; page < pages; page++) {
    const res = await backfillSearch(search.api_filters || {}, fetchLimit, offset);
    adIds.push(...res.ids);
    if (res.total != null) total = res.total;
    if (res.dropped?.length) dropped = res.dropped;
    offset = res.offset + res.ids.length;

    // exhausted: either the API returned a short page or we passed the
    // total or JobSearch's offset ceiling
    if (!res.ids.length || (total != null && offset >= total) || offset >= 2000) {
      offset = 0;
      await pool.query(
        `UPDATE searches SET fetch_done_at = now() WHERE id = $1`, [searchId]
      );
      break;
    }
  }

  // Persist the broadening decision, don't just record it. A filter the
  // API rejects makes EVERY scan fall down the ladder, and the ladder
  // restarts at offset 0 — so leaving the bad key in api_filters pins
  // the cursor to page one forever. Strip it once; the warning banner
  // keeps the user informed that it was dropped.
  if (dropped.length) {
    const cleaned = { ...(search.api_filters || {}) };
    for (const k of dropped) delete cleaned[k];
    await pool.query(
      `UPDATE searches SET api_filters = $2 WHERE id = $1`,
      [searchId, JSON.stringify(cleaned)]
    );
  }

  await pool.query(
    `UPDATE searches SET fetch_offset = $2, fetch_total = $3,
       dropped_filters = COALESCE($4, dropped_filters) WHERE id = $1`,
    [searchId, offset, total, dropped.length ? dropped : null]
  );

  // Restricted to the ads layer 1 actually selected for THIS search.
  // Without that restriction we'd store the newest ads in the whole
  // global pool (every job in Sweden). Ads stay global; only the
  // candidate set is per-search.
  //
  // apply_filter is NOT applied here any more. It was a find-time
  // exclusion because every stored ad used to cost a scoring call, so
  // hiding the 78% you cannot email saved real money. On this branch
  // nothing is scored until you ask, so excluding at find time buys
  // nothing and only hides jobs from the list you browse. It is a
  // display filter now — see the results route.
  const { rows: ads } = await pool.query(
    `SELECT a.* FROM ads a
     LEFT JOIN match_results m ON m.ad_id = a.id AND m.search_id = $1
     LEFT JOIN never_apply na ON na.fingerprint = a.fingerprint
     WHERE m.id IS NULL
       AND a.removed_at IS NULL
       AND na.fingerprint IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
       AND ($2::uuid[] IS NULL OR a.id = ANY($2))
     ORDER BY a.published_at DESC NULLS LAST`,
    [searchId, adIds]
  );

  const profileTerms = buildProfileTerms({
    criteriaText: search.criteria_text, cvText: search.cv_text,
    apiFilters: search.api_filters || {},
  });
  // The prefilter no longer REJECTS anything either — it only ranks.
  // Its job was to keep ads away from a scorer that ran automatically.
  // Nothing runs automatically now, and a candidate list that quietly
  // drops ads is the thing the user is browsing to avoid.
  const triaged = ads.map((ad) => ({ ad, ...prefilterAd(ad, profileTerms) }));
  const candidates = triaged.sort((a, b) => b.score - a.score);
  const skipped = [];

  // Every survivor is stored as a CANDIDATE — shortlisted_at NULL,
  // score NULL. No model has seen any of them and none will until the
  // user shortlists it. `limit` therefore defaults to null (no cap):
  // the old cap of 20 existed because each queued ad meant an LLM
  // call, and that is no longer true.
  //
  // queue_rank still carries the prefilter's confidence, now used to
  // order the candidate list rather than a scoring queue.
  const admit = limit == null ? candidates : candidates.slice(0, limit);
  let found = 0;
  for (const { ad, score } of admit) {
    const { rowCount } = await pool.query(
      `INSERT INTO match_results (search_id, ad_id, queue_rank)
       VALUES ($1, $2, $3)
       ON CONFLICT (search_id, ad_id) DO NOTHING`,
      [searchId, ad.id, score]
    );
    found += rowCount;
  }

  await pool.query(`UPDATE searches SET last_scanned_at = now() WHERE id = $1`, [searchId]);
  const depth = total != null ? ` — ${offset || total}/${total} genomsökt` : '';
  console.log(`found ${found} candidates for "${search.name}" (${skipped.length} förfiltrerade)${depth}`);
  return { found, skipped: skipped.length, seen: ads.length, total, offset };
}

// ------------------------------------------------------------
// SCORE — the only part that costs money, and the only part gated
// on a human decision. It judges ads the user EXPLICITLY asked to
// have scored and nothing else: the WHERE clause below is the whole
// point of this branch.
//
// Note it keys on score_requested_at, not shortlisted_at. Favouriting
// is free; a favourites tab where favouriting silently triggered a
// model call would just move the old problem behind a click.
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
       AND m.score_requested_at IS NOT NULL  -- the gate: no explicit request, no spend
       AND m.score IS NULL
       AND m.attempts < $3
       AND a.removed_at IS NULL
       AND na.fingerprint IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
     ORDER BY m.score_requested_at, a.published_at DESC NULLS LAST
     LIMIT $2`,
    [searchId, limit, MAX_SCORE_ATTEMPTS]
  );

  if (!ads.length) return [];
  console.log(`scoring ${ads.length} requested ads for "${search.name}"`);
  const results = [];

  for (const ad of ads) {
    try {
      const r = await scoreAd({
        ad,
        profile: {
          cv_text: search.cv_text,
          about_text: search.about_text,
          cv_profile_rendered: renderCvProfile(search.cv_profile),
        },
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
// A scan now FINDS ONLY. It costs one HTTP request per page and no
// model calls at all, so it can page deep into the result set and
// store every match as a candidate.
//
// Scoring is not part of a scan any more. It happens when the user
// asks for it on specific ads (POST /api/searches/:id/score), which
// is the entire point of this branch: the expensive step sits behind
// a human decision instead of in front of one.
// ------------------------------------------------------------
export async function scanSearch(searchId, { fetchLimit = 100, pages = 1, limit = null } = {}) {
  return queueSearch(searchId, { fetchLimit, pages, limit });
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
