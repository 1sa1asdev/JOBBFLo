import { pool } from './db.js';
import { llmJson } from './llm.js';

// ------------------------------------------------------------
// LAYER 1 — natural language -> structured API filters.
// Cheap server-side narrowing. Runs once per search, not per ad.
// ------------------------------------------------------------
const FILTER_SYSTEM = `Du översätter en jobbsökandes egna ord till filter för Arbetsförmedlingens JobSearch API.

Tillgängliga filter:
- q (fritext). VARNING: orden AND:as — "frontend backend utvecklare" kräver att
  ALLA tre finns i samma annons och ger nästan alltid NOLL träffar.
  Använd högst ETT ord, eller utelämna q helt.
  Räkna aldrig upp synonymer eller alternativ i q — det smalnar av, det breddar inte.
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
- occupation-group: yrkesgrupp, t.ex. "Mjukvaru- och systemutvecklare m.fl.".
  VIKTIGT: yrkesaxlarna OR:as av API:t. Sätter du både occupation-field och
  occupation-group får du det BREDARE av de två, inte snittet — uppmätt:
  fält+orter 1288, fält+grupp+orter 1288, bara grupp+orter 566.
  Sätt alltså ENDAST den smalaste axel du är säker på. Är yrket tydligt:
  occupation-group i stället för occupation-field, inte utöver.
- occupation-name: exakt yrkesbenämning, t.ex. "Undersköterska",
  "Systemutvecklare/Programmerare". Smalast av alla, och OR:as likadant —
  sätt den ensam, utan fält och grupp. Bara när kandidaten namnger yrket;
  gissar du fel blir resultatet tomt.
- experience: true|false. OBS: heter INTE experience-required — det namnet
  accepteras av API:t och filtrerar ingenting alls (43202 träffar, dvs allt).
  false = jobb som inte kräver erfarenhet, 3035 av 43202 annonser.
- trainee: true — praktik- och traineeplatser (12 annonser just nu)
- larling: true — lärlingsplatser (19 annonser)
- remote: true|false
- published-after (ISO-datum)

Svara ENDAST med JSON, ingen förklaring, inga kodstaket:
{"filters": {...}, "unmapped": ["kriterier som inte går att uttrycka som filter"]}

Det som hamnar i "unmapped" hanteras i ett senare steg mot annonstexten — var generös med vad du lägger där. Filtren ska vara BREDA: hellre för många träffar än att missa jobb.

VIKTIGT — sätt BARA filter som kandidatens ord uttryckligen säger. Härled aldrig.
Varje filter är också en mängd jobb kandidaten aldrig får se, så appen visar
vidare avsmalningar som förslag med antal träffar, och kandidaten väljer själv.
- Yrkesaxlarna (occupation-field/-group/-name) sätts bara när kandidaten själv
  pekar ut området: "jobb inom IT-branschen" → occupation-field Data/IT,
  "inom vården" → Hälso- och sjukvård, "restaurangbranschen" → Hotell,
  restaurang, storhushåll.
- Ett yrkesord är INTE ett uttalat område: "frontendutvecklare", "utvecklare",
  "restaurangbiträde", "undersköterska" → inga yrkesfilter; lägg yrket i
  "unmapped". Appen föreslår yrkesgrupp och yrke därifrån.
- Ort, omfattning, erfarenhet, distans, anställningsform: samma regel — bara
  när kandidaten sagt det.
- Undantag ("ej lager", "inte säljjobb") blir aldrig filter; de går i "unmapped".

VIKTIGT — filter som oftast ger noll träffar, använd dem nästan aldrig:
- remote: sätt ENDAST om kandidaten kräver helt distansarbete. "Hybrid är okej",
  "kan pendla", "helst distans" är önskemål → lägg i "unmapped", inte som filter.
- employment-type: utelämna om det inte är ett uttryckligt krav.
- trainee och larling är mycket små urval (12 respektive 19 annonser i hela
  landet) — sätt dem bara om kandidaten uttryckligen söker just det.
- Dessa finns i API:t men filtrerar ingenting, uppmätt mot det ofiltrerade
  totalet: open-for-all, driving-licence-required, hire-work, timeframe,
  parttime.greater-than, parttime.less-than. Använd dem aldrig — ett filter
  som inte gör något läser som en avsmalning som ägt rum.
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
// LAYER 2 — the requirement checklist (src/checklist.js).
//
// This was one prompt that read the whole ad and the whole CV and
// answered with a 0-100 it chose itself. That number could not be
// checked, was not stable (the same reposted job came back 25 one
// time and 50 the next), and was bought again for every search the
// ad turned up in.
//
// It is now two steps that can be checked: the ad’s requirements
// read once per ad, then each requirement answered against the CV
// with a verbatim quote from both sides. The score is arithmetic
// over those rows. What stays in this file is the queue around it —
// the budget, the twin reuse, the retry rules.
// ------------------------------------------------------------

// The ad as the app shows it. Quotes coming back from any step are
// checked against exactly this, because a quote can only be judged
// against the text it was drawn from — and this is also what the UI
// highlights.
export function adTextShownToModel(ad) {
  return [
    ad.title,
    ad.employer,
    ad.municipality,
    ad.deadline,
    ad.ats_vendor,
    ad.description,
  ].filter(Boolean).join('\n');
}

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
// QUEUE — the free half of a scan. It writes a match_results row per
// candidate with score NULL, which is what lets the UI list the jobs a
// second after the user asks rather than after a batch has been judged.
//
// Match a search against the ad pool.
//
// This used to page JobSearch per search, with a cursor, an offset
// ceiling and a broadening ladder of its own. The pool now answers it
// — see src/localsearch.js for why, and for the counts that showed the
// two sources agree. The ads themselves still arrive through the feed.
//
// The options are kept so every caller and the worker keep working;
// there are no pages any more, so only `limit` still means anything.
// ------------------------------------------------------------
export async function queueSearch(searchId, { limit = null } = {}) {
  const { search } = await loadSearchContext(searchId, { needCv: false });
  const { matchSearch } = await import('./localsearch.js');
  const r = await matchSearch(searchId, ...(limit ? [{ limit }] : []));
  console.log(`found ${r.found} candidates for "${search.name}" — ${r.total} i poolen`
    + `${r.dropped.length ? `, släppte ${r.dropped.join(', ')}` : ''}`);
  return { found: r.found, skipped: 0, seen: r.total, total: r.total, offset: 0 };
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

// How many more ads may be scored today, for the profile this search
// belongs to. The budget is per day and per profile, not per search —
// five searches draining at once must share one allowance, or the cap
// is five times what it says.
async function scoreBudgetLeft(searchId) {
  const { rows: [b] } = await pool.query(
    `SELECT p.daily_score_limit AS cap,
       (SELECT count(*) FROM match_results m2
        JOIN searches s2 ON s2.id = m2.search_id
        WHERE s2.profile_id = p.id
          AND m2.scored_at >= date_trunc('day', now())
          -- a copied verdict cost nothing and must not use up the
          -- allowance a real judgement would need
          AND m2.score_reused_from IS NULL) AS used
     FROM searches s JOIN profile p ON p.id = s.profile_id
     WHERE s.id = $1`, [searchId]
  );
  if (!b) return 0;
  return { left: Math.max(0, Number(b.cap) - Number(b.used)),
           cap: Number(b.cap), used: Number(b.used) };
}

// ------------------------------------------------------------
// One verdict per job.
//
// A repost arrives with a new ad id and the same fingerprint (employer
// + title + municipality), and the queue used to judge it from scratch:
// 18 of 1026 scores, Amazon's "DCO Technician" four times at 10 each —
// and ChopChop's "Restaurangmedarbetare 50%" at 25 one time and 50 the
// next, for the same job in the same search. A second opinion on an
// identical ad is not caution, it is a coin toss that costs money.
//
// Three conditions, each for a reason:
//
//   same search      criteria differ between searches, so a verdict
//                    only transfers within the search that produced it
//                    (CLAUDE.md #1: the same ad scores differently in
//                    different searches, correctly)
//
//   not stale        a twin judged before the criteria last changed
//                    answered a different question
//
//   quotes verbatim  reposts are sometimes edited. matched[].quote and
//                    flags[].quote must appear in THIS ad's text or the
//                    highlights point at nothing (CLAUDE.md #5) — so a
//                    single quote that no longer appears means the ad
//                    changed, and it is scored fresh
//
// The ad is not merged or hidden (CLAUDE.md #4): it keeps its own row
// and stays visible. Only the model call is skipped, and
// score_reused_from records where the verdict came from, which also
// keeps it off the daily scoring budget — nothing was paid for.
// ------------------------------------------------------------
async function reuseTwinVerdict(searchId, ad, search) {
  if (!ad.fingerprint) return null;
  const { rows: [tvilling] } = await pool.query(
    `SELECT m.id, m.score, m.summary, m.matched, m.flags, m.lead_project_id, m.scored_at
     FROM match_results m JOIN ads a ON a.id = m.ad_id
     WHERE m.search_id = $1
       AND a.fingerprint = $2
       AND a.id <> $3
       AND m.score IS NOT NULL
       AND m.score_reused_from IS NULL          -- copy from originals only
       AND ($4::timestamptz IS NULL OR m.scored_at >= $4)
     ORDER BY m.scored_at DESC
     LIMIT 1`,
    [searchId, ad.fingerprint, ad.id, search.criteria_changed_at || null]
  );
  if (!tvilling) return null;

  const text = adTextShownToModel(ad);
  const matched = verifyQuotes(tvilling.matched || [], text);
  const flags = verifyQuotes(tvilling.flags || [], text);
  if ([...matched, ...flags].some((q) => !q.verbatim)) return null;

  await pool.query(
    `UPDATE match_results SET
       score = $3, summary = $4, matched = $5, flags = $6,
       lead_project_id = $7, scored_at = now(), last_error = NULL,
       score_reused_from = $8
     WHERE search_id = $1 AND ad_id = $2`,
    [searchId, ad.id, tvilling.score, tvilling.summary,
     JSON.stringify(matched), JSON.stringify(flags),
     tvilling.lead_project_id, tvilling.id]
  );
  return { score: tvilling.score, summary: tvilling.summary, matched, flags };
}

async function drainQueue(searchId, { limit }) {
  const { search } = await loadSearchContext(searchId);
  // Imported here rather than at the top: checklist.js needs
  // verifyQuotes from this file, and two modules importing each other
  // at load time is a cycle waiting to hand one of them an undefined.
  const { checkAd, tillMatchResult } = await import('./checklist.js');

  // Checked before the queue is read, so a spent budget costs one cheap
  // count instead of a page of ads we are not allowed to judge.
  const budget = await scoreBudgetLeft(searchId);
  if (!budget.left) {
    console.log(`dygnsgränsen nådd: ${budget.used}/${budget.cap} bedömda idag — inget mer bedöms förrän imorgon`);
    return [];
  }
  limit = Math.min(limit, budget.left);

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
    // Re-checked per ad, not just per batch. Two searches draining
    // concurrently each hold their own advisory lock, so a batch-level
    // clamp alone would let each take the full allowance and spend
    // double the cap. This is the check that makes the number real.
    const now = await scoreBudgetLeft(searchId);
    if (!now.left) {
      console.log(`dygnsgränsen nådd mitt i kön: ${now.used}/${now.cap} — resten väntar till imorgon`);
      break;
    }

    // A twin already judged in this search — same job, reposted — hands
    // over its verdict instead of the model being asked again.
    const kopia = await reuseTwinVerdict(searchId, ad, search);
    if (kopia) {
      results.push({ ad, ...kopia, reused: true });
      console.log(`  ${String(kopia.score).padStart(3)} · ${ad.title} — ${ad.employer} (samma jobb, återanvänd bedömning)`);
      continue;
    }

    try {
      // The checklist, not a number the model picked: the ad's
      // requirements answered one by one against the CV, and the score
      // computed from those rows (src/checklist.js). Stored per
      // (ad, CV), so a second search that finds the same ad pays
      // nothing — the question "does this CV meet these requirements"
      // never depended on which search found the job.
      const rad = await checkAd(ad, {
        cvText: search.cv_text,
        cvProfile: search.cv_profile,
        mustCriteria: search.must_criteria,
      });
      const r = tillMatchResult(rad);

      // The quotes in matched/flags are the ad's own words, taken from
      // requirement rows that were checked against the ad when they
      // were read. Re-checked here anyway, against the same text the
      // UI highlights, because that invariant is worth two lines.
      const visadText = adTextShownToModel(ad);
      r.matched = verifyQuotes(r.matched, visadText);
      r.flags = verifyQuotes(r.flags, visadText);

      // UPDATE, not INSERT: the row already exists from the queue
      // step. UNIQUE(search_id, ad_id) still means one row per pair.
      await pool.query(
        `UPDATE match_results SET
           score = $3, summary = $4, matched = $5, flags = $6,
           check_cv_key = $7, scored_at = now(), last_error = NULL
         WHERE search_id = $1 AND ad_id = $2`,
        [searchId, ad.id, r.score, r.summary,
         JSON.stringify(r.matched), JSON.stringify(r.flags),
         rad.cv_key]
      );

      results.push({ ad, ...r });
      console.log(`  ${String(r.score).padStart(3)} · ${ad.title} — ${ad.employer}`);
    } catch (err) {
      // `attempts` exists to stop ONE bad ad being retried for ever — a
      // description that always breaks the parser, say. A rate limit is
      // not that ad's fault, and on a free tier it is the normal answer
      // to a burst: queueing 65 ads at once burned all three attempts in
      // seconds and parked every one of them permanently. The queue then
      // read "65 väntar" while nothing would ever move again.
      //
      // A transient failure records the reason without spending an
      // attempt, so the ad returns on the next tick with the quota
      // refilled.
      // A key that is out of credit is not this ad's fault either. It
      // read "Kunde inte bedömas" on every card in the list, and three
      // ticks of that parks the whole queue permanently — so when the
      // key is topped up, nothing moves until each ad is reset by hand.
      const transient = err.transient
        || /429|rate|quota|timeout|ETIMEDOUT|ECONNRESET|användbart svar/i.test(err.message || '')
        || /\b(401|402|403)\b|nyckeln avvisades|key limit|insufficient|credit/i.test(err.message || '');
      await pool.query(
        `UPDATE match_results SET attempts = attempts + $4, last_error = $3
         WHERE search_id = $1 AND ad_id = $2`,
        [searchId, ad.id, err.message, transient ? 0 : 1]
      );
      console.error(`  !! ${ad.title}: ${err.message}${transient ? ' (försöker igen)' : ''}`);
      // A provider that just rate-limited will do it again straight
      // away, so stop the batch instead of burning the rest failing.
      if (transient) break;
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
       -- An application the user made through the ad's own link has no
       -- message_id and often gets answered in a thread or an ATS this
       -- app never sees. Silence there is missing data, not a rejection,
       -- and counting it as one would drag every band's response rate
       -- down for a reason that has nothing to do with the score.
       AND app.sent_by <> 'external'
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
