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
- q (fritext). VARNING: orden AND:as — "frontend backend utvecklare" kräver att
  ALLA tre finns i samma annons och ger nästan alltid NOLL träffar.
  Använd högst ETT ord, eller utelämna q helt och lita på occupation-field.
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
- occupation-group: yrkesgrupp, t.ex. "Mjukvaru- och systemutvecklare m.fl.",
  "Undersköterskor, hemtjänst, äldreboende". Smalare än occupation-field och
  betydligt billigare för bedömningen — använd den när yrket är tydligt.
- occupation-name: exakt yrkesbenämning, t.ex. "Undersköterska",
  "Systemutvecklare/Programmerare". Smalast av alla. Sätt den bara när
  kandidaten namnger yrket; gissar du fel blir resultatet tomt.
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

// The ad as the model sees it. One definition, used both to build the
// prompt's ad block and to check the quotes that come back — they
// drifted apart, and a quote can only be judged against the text it was
// drawn from.
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

function adTextForScoring(description) {
  const text = String(description || '');
  if (text.length <= AD_CHARS_MAX) return text;
  const cut = text.slice(0, AD_CHARS_MAX);
  const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  return `${cut.slice(0, lastBreak > AD_CHARS_MAX * 0.6 ? lastBreak : AD_CHARS_MAX)}\n\n[…annonsen fortsätter]`;
}

// The ad profile is deliberately NOT in this prompt.
//
// It belongs here in principle: the candidate block is a structured
// reading, and the ad arriving as raw prose is exactly the asymmetry
// ad_profile exists to remove. But measured on six ads, same ads both
// ways, it cost quote fidelity:
//
//   without the profile   23/33 quotes verbatim in the ad  (70%)
//   with the profile      22/37                            (59%)
//
// Given a structured summary to reason from, this model quotes the
// summary — and matched[].quote / flags[].quote must be verbatim in
// ad.description or the UI highlights nothing and a letter's claims
// point at text no employer wrote (CLAUDE.md #5). Printing the evidence
// beside each requirement helped (0/2 before that, 9/11 after) and
// still did not reach the baseline.
//
// So the profile serves the embedding, where there are no quotes to get
// wrong, and scoring keeps reading the ad's own words. Worth revisiting
// on a stronger bulk model: the 70% baseline is llama-3.1-8b-instant,
// and gemini-2.5-flash measured 95% on this same invariant.

export async function scoreAd({ ad, profile, projects, criteriaText, mustCriteria }) {
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
${mustCriteria ? `
## ABSOLUT KRAV — ANNONSEN MÅSTE UPPFYLLA DETTA
${mustCriteria}

Detta är ett villkor, inte en önskan. Uppfyller annonsen det inte:
sätt score till högst 15, och lägg till i flags ett objekt med
tag "ska-krav" och ett ordagrant citat ur annonsen som visar varför
den inte uppfyller kravet. Är det omöjligt att avgöra från
annonstexten, behandla kravet som INTE uppfyllt — en gissning här
leder till ett brev som aldrig skulle ha skickats.
` : ''}
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
// fromStart reads page one regardless of where the sweep's cursor sits,
// and leaves that cursor where it was. The two are one feature: a
// newly published ad is at the front of the result set, and the deep
// sweep may be nine hundred ads into the back of it — so the only way
// to see today's ads without abandoning the sweep's position is to look
// at the front and then put the cursor back.
export async function queueSearch(searchId, {
  fetchLimit = 100, limit = null, pages = 1, fromStart = false,
} = {}) {
  const { search } = await loadSearchContext(searchId);

  const { backfillSearch } = await import('./fetchJobs.js');

  // Walk the result set instead of re-reading page one. Each scan
  // advances the cursor; when it passes the reported total it wraps to
  // 0 so the next scan picks up newly published ads. Finding is free,
  // so paging deep costs one HTTP request per page and nothing else.
  const cursorFöre = search.fetch_offset || 0;
  let offset = fromStart ? 0 : cursorFöre;
  let total = search.fetch_total ?? null;
  let dropped = [];
  const adIds = [];

  for (let page = 0; page < pages; page++) {
    const res = await backfillSearch(search.api_filters || {}, fetchLimit, offset);
    adIds.push(...res.ids);
    if (res.total != null) total = res.total;
    if (res.dropped?.length) dropped = res.dropped;
    // Advance by what the API served, not by what we kept. Ads filtered
    // out on omfattning still take up their place in the result set, so
    // counting only the keepers walked the cursor at half speed and
    // re-read the same window every page.
    const read = res.fetched ?? res.ids.length;
    offset = res.offset + read;

    // exhausted: either the API returned a short page or we passed the
    // total or JobSearch's offset ceiling
    if (!read || (total != null && offset >= total) || offset >= 2000) {
      offset = 0;
      // Only a real sweep can declare itself finished. A front-of-list
      // check on a small result set reaches the end after one page, and
      // letting that stamp fetch_done_at would tell a campaign whose
      // first sweep is still running that it had swept everything.
      if (!fromStart) {
        await pool.query(
          `UPDATE searches SET fetch_done_at = now() WHERE id = $1`, [searchId]
        );
      }
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
    // A front-of-list check must not cost the sweep its place. Writing
    // the offset this pass happened to reach would rewind a campaign
    // that is nine hundred ads deep back to one hundred, and it would
    // re-read the same early pages every time a new ad arrived.
    [searchId, fromStart ? cursorFöre : offset, total, dropped.length ? dropped : null]
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
          AND m2.scored_at >= date_trunc('day', now())) AS used
     FROM searches s JOIN profile p ON p.id = s.profile_id
     WHERE s.id = $1`, [searchId]
  );
  if (!b) return 0;
  return { left: Math.max(0, Number(b.cap) - Number(b.used)),
           cap: Number(b.cap), used: Number(b.used) };
}

async function drainQueue(searchId, { limit }) {
  const { search, projects } = await loadSearchContext(searchId);

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
        mustCriteria: search.must_criteria,
      });

      const leadProject = projects.find((p) => p.name === r.lead_project);
      // Against everything the model was shown about the ad, not just
      // the description. The prompt includes the title, employer, town
      // and deadline, and a quote lifted from the title is verbatim in
      // what the model read — marking it otherwise called the model a
      // liar for doing exactly what it was asked. Measured on six ads:
      // 32/46 quotes verified against the description alone, 36/46
      // against the text actually presented. The UI shows the title
      // too, so those eight are highlightable either way.
      const visadText = adTextShownToModel(ad);
      r.matched = verifyQuotes(r.matched, visadText);
      r.flags = verifyQuotes(r.flags, visadText);

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
      const transient = err.transient
        || /429|rate|quota|timeout|ETIMEDOUT|ECONNRESET|användbart svar/i.test(err.message || '');
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
