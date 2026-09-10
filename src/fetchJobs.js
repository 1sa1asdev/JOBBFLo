import crypto from 'node:crypto';
import { pool } from './db.js';
import { resolveFilters } from './taxonomy.js';

const JOBSTREAM = 'https://jobstream.api.jobtechdev.se/stream';
const JOBSEARCH = 'https://jobsearch.api.jobtechdev.se/search';

// ------------------------------------------------------------
// fingerprint: soft dedupe key.
// employer + title + municipality, normalized.
// deliberately NOT the deadline — that's the thing that changes
// when an employer reposts the same job with a new id.
// ------------------------------------------------------------
export function fingerprint({ employer, title, municipality }) {
  const norm = (s) =>
    (s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(ab|aktiebolag|hb|kb|group|sverige|nordic)\b/g, '')
      .replace(/[^a-z0-9]+/g, '')
      .trim();

  return crypto
    .createHash('sha256')
    .update([norm(employer), norm(title), norm(municipality)].join('|'))
    .digest('hex')
    .slice(0, 32);
}

// ------------------------------------------------------------
// ATS detection: changes what we generate. An ad routing to
// Teamtailor needs a form-pasteable letter, not an email.
// ------------------------------------------------------------
const ATS_PATTERNS = [
  [/teamtailor\.com/i, 'teamtailor'],
  [/varbi\.com/i, 'varbi'],
  [/myworkdayjobs\.com|workday/i, 'workday'],
  [/reachmee\.com/i, 'reachmee'],
  [/jobylon\.com/i, 'jobylon'],
  [/greenhouse\.io/i, 'greenhouse'],
  [/lever\.co/i, 'lever'],
  [/successfactors|sapsf/i, 'successfactors'],
];

export function detectAts(ad) {
  const haystack = [
    ad.application_details?.url,
    ad.application_details?.other,
    ad.source_links?.map((l) => l.url).join(' '),
    ad.description?.text,
  ]
    .filter(Boolean)
    .join(' ');

  for (const [re, name] of ATS_PATTERNS) {
    if (re.test(haystack)) return name;
  }
  return null;
}

// ------------------------------------------------------------
// employer type: priors for the ghosting/response model.
// Agencies reply fast or never; public sector is slow but
// almost always responds. Rough but far better than nothing.
// ------------------------------------------------------------
const AGENCIES = /academic work|manpower|randstad|adecco|poolia|dfind|experis|framtiden|wise professionals|jefferson wells/i;
const PUBLIC = /kommun|region |landsting|myndighet|universitet|högskola|statens|försäkringskassan|arbetsförmedlingen|polisen|trafikverket/i;

export function employerType(name = '') {
  if (AGENCIES.test(name)) return 'agency';
  if (PUBLIC.test(name)) return 'public';
  return 'private';
}

// ------------------------------------------------------------
// normalize a JobTech ad into our shape
// ------------------------------------------------------------
function mapAd(ad) {
  const employer = ad.employer?.name || ad.employer?.workplace || 'Okänd arbetsgivare';
  const municipality = ad.workplace_address?.municipality || null;

  return {
    source: 'platsbanken',
    external_id: ad.id,
    fingerprint: fingerprint({ employer, title: ad.headline, municipality }),
    title: ad.headline,
    employer,
    employer_type: employerType(employer),
    municipality,
    region: ad.workplace_address?.region || null,
    description: ad.description?.text || '',
    apply_email: ad.application_details?.email || null,
    apply_url: ad.application_details?.url || null,
    ats_vendor: detectAts(ad),
    published_at: ad.publication_date || null,
    deadline: ad.application_deadline ? ad.application_deadline.slice(0, 10) : null,
    removed_at: ad.removed ? ad.removed_date || new Date().toISOString() : null,
    raw: ad,
  };
}

async function upsertAd(client, a) {
  const { rows } = await client.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, employer_type,
                      municipality, region, description, apply_email, apply_url,
                      ats_vendor, published_at, deadline, removed_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       deadline = EXCLUDED.deadline,
       removed_at = EXCLUDED.removed_at,
       ats_vendor = EXCLUDED.ats_vendor,
       raw = EXCLUDED.raw
     -- Only write when something actually differs. The stream re-sends
     -- roughly the same 570 ads on every poll whatever window is asked
     -- for, so at a one-minute interval this was rewriting ~380 rows a
     -- minute that had not changed — a dead row per ad per poll for
     -- vacuum to clean up, and the embedding and scan paths seeing
     -- churn where there was none.
     WHERE ads.raw IS DISTINCT FROM EXCLUDED.raw
        OR ads.removed_at IS DISTINCT FROM EXCLUDED.removed_at
     RETURNING id, (xmax = 0) AS inserted`,
    [a.source, a.external_id, a.fingerprint, a.title, a.employer, a.employer_type,
     a.municipality, a.region, a.description, a.apply_email, a.apply_url,
     a.ats_vendor, a.published_at, a.deadline, a.removed_at, a.raw]
  );
  if (rows[0]) return { ...rows[0], unchanged: false };

  // No row means the WHERE above found nothing to change — the common
  // case. The id is still needed: backfillSearch uses these ids to
  // decide which ads become candidates for a search, so returning null
  // did not merely crash it, it would have quietly stopped every
  // unchanged ad from being matched into any search.
  //
  // A SELECT rather than a no-op UPDATE. Both return the id; only one
  // of them leaves a dead row behind per ad per poll, which is the
  // whole reason the WHERE is there.
  const { rows: [fanns] } = await client.query(
    `SELECT id FROM ads WHERE source = $1 AND external_id = $2`,
    [a.source, a.external_id]
  );
  return fanns ? { id: fanns.id, inserted: false, unchanged: true } : null;
}

// ------------------------------------------------------------
// JobStream poll: ONE global fetch, shared by every search.
// Never one fetch per search — five hourly searches would
// otherwise mean five identical pulls.
// ------------------------------------------------------------
export async function pollJobStream({ occupationConceptIds = [] } = {}) {
  const client = await pool.connect();
  try {
    const { rows: [state] } = await client.query(
      `SELECT cursor_ts FROM poll_state WHERE key = 'jobstream'`
    );

    // JobStream wants ISO without milliseconds
    const since = new Date(state.cursor_ts).toISOString().replace(/\.\d{3}Z$/, '');
    const params = new URLSearchParams({ date: since });
    for (const id of occupationConceptIds) {
      params.append('occupation-concept-id', id);
    }

    const url = `${JOBSTREAM}?${params}`;
    console.log(`→ ${url}`);

    const headers = { accept: 'application/json' };
    if (process.env.JOBSTREAM_API_KEY) headers['api-key'] = process.env.JOBSTREAM_API_KEY;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`JobStream ${res.status}: ${await res.text()}`);

    const ads = await res.json();
    console.log(`  ${ads.length} ads in stream`);

    let created = 0, updated = 0, removed = 0, skipped = 0, unchanged = 0;
    for (const raw of ads) {
      try {
        // removed ads come through the stream stripped of everything but
        // id + removed flag — never upsert those, just mark ours removed
        if (raw.removed) {
          // Only the ones not already marked. COALESCE made this
          // idempotent in its effect but not in its cost: the stream
          // re-sends the same withdrawn ads on every poll, so this
          // rewrote 191 rows a minute to set them to the value they
          // already held. The count now means "newly withdrawn", which
          // is also the only number worth printing.
          const { rowCount } = await client.query(
            `UPDATE ads SET removed_at = $2
             WHERE source = 'platsbanken' AND external_id = $1
               AND removed_at IS NULL`,
            [String(raw.id), raw.removed_date || new Date().toISOString()]
          );
          removed += rowCount;
          continue;
        }
        if (!raw.headline) { skipped++; continue; }
        const r = await upsertAd(client, mapAd(raw));
        if (!r) skipped++;
        else if (r.unchanged) unchanged++;
        else if (r.inserted) created++;
        else updated++;
      } catch (err) {
        skipped++;
        console.error(`  !! ad ${raw?.id}: ${err.message}`);
      }
    }

    await client.query(
      `UPDATE poll_state SET cursor_ts = now(), last_run_at = now() WHERE key = 'jobstream'`
    );

    console.log(`  +${created} new  ~${updated} updated  -${removed} removed`
      + `  =${unchanged} unchanged  (${skipped} skipped)`);
    return { created, updated, removed, skipped, unchanged, total: ads.length };
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// JobSearch: used for the FIRST fill of a new search (backfill),
// since JobStream only gives you changes going forward.
// ------------------------------------------------------------
// Filters most likely to over-narrow, dropped first when a query
// comes back empty. Layer 1 is an LLM guessing at an API: it will
// sometimes turn "hybrid är okej" into remote=true and match nothing.
// An empty result is the worst failure mode here — it's
// indistinguishable from "no such jobs exist" — so broaden and retry.
// JobSearch refuses offsets past 2000, so a result set larger than this
// cannot be paged through however long we are willing to wait. Above it
// the worktime filter has to stay on the API side.
const RELAX_CAP = 2000;

// Ordered least-intentional first, because broadening throws something
// away and the user should lose the app's guesses before their own
// choices.
//
// `q` sits high for a reason: JobSearch ANDs its terms, so a four-word
// free text asks for ads containing ALL of them and routinely matches
// nothing. A real campaign here was written as "frontend backend
// mjukvaru utvecklare" and returned 0 hits — while "frontendutvecklare"
// with a municipality returned 26. Because q was not on this ladder, the
// only thing left to drop was the geography, so the user's three chosen
// cities were stripped and persisted, and the search stayed empty for a
// reason that had nothing to do with where they wanted to work.
//
// municipality and region go last and together: a place is the one
// filter the user almost always typed themselves.
const BROADENING_LADDER = [
  ['remote', 'employment-type'],
  ['experience-required'],
  ['q'],
  ['occupation-field', 'occupation-group'],
  ['municipality', 'region'],
];

function buildQuery(filters, limit, offset = 0) {
  const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
  // JobSearch pages with offset and accepts it up to 2000. Without it
  // every scan re-read the first page forever: a search with 330 hits
  // could only ever reach 50 of them, and the other 280 were not
  // "unscored" but unreachable.
  if (offset > 0) params.set('offset', String(Math.min(offset, 2000)));
  if (filters.q) params.set('q', filters.q);
  for (const key of ['occupation-field', 'occupation-group', 'municipality', 'region',
                     'employment-type', 'worktime-extent', 'experience-required',
                     'remote', 'published-after']) {
    const val = filters[key];
    if (val === undefined || val === null) continue;
    for (const v of [].concat(val)) {
      // An empty value is not "no filter" to JobSearch — it is a filter
      // that matches nothing, so `employment-type=` returns 0 hits and
      // sends every scan down the broadening ladder. That wasted a
      // request per scan, and once pagination existed it was worse:
      // broadening restarts at offset 0, so a search carrying one blank
      // filter could never advance past page one.
      const str = String(v).trim();
      if (!str) continue;
      params.append(key, str);
    }
  }
  return params;
}

async function runQuery(params) {
  const url = `${JOBSEARCH}?${params}`;
  console.log(`→ ${url}`);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JobSearch ${res.status}: ${await res.text()}`);
  return res.json();
}

// Returns { ids, total, offset } so the caller can page through the
// whole result set instead of re-reading the first page each scan.
export async function backfillSearch(rawFilters = {}, limit = 100, offset = 0) {
  // names -> taxonomy concept IDs. Skipping this silently returns
  // zero hits (the API doesn't error on an unknown name).
  let filters = await resolveFilters(rawFilters);

  // ----------------------------------------------------------
  // "Deltid" is a preference, not a fact the data reliably carries.
  //
  // Of 455 restaurant ads in Stockholm, 247 say Heltid, 120 say Deltid,
  // and 88 say NOTHING AT ALL on this axis. Asking JobSearch for
  // worktime-extent=Deltid returns the 120 and silently discards the 88
  // — among them "Spelledare (kvällar och helger)", "Nattreceptionist
  // för extraarbete" and two "Chef - Extra". Those are the exact jobs
  // the filter was meant to find, and they were invisible.
  //
  // The API cannot express "Deltid OR unspecified", so the only way to
  // see the unmarked ads is to ask without the filter and sort them out
  // here: keep the wanted extent, keep the unmarked, drop only ads that
  // explicitly say something else. That is the same rule as the dupe
  // check — hiding a job the user hasn't seen is the worse failure.
  //
  // It is not free: the relaxed set is larger, so it costs more pages.
  // Above RELAX_CAP we keep the hard filter, because JobSearch refuses
  // offsets past 2000 and a set that big cannot be paged through at all.
  // Pages are free (no model runs until the user asks), so the ceiling
  // is the API's, not the budget's.
  // ----------------------------------------------------------
  const wanted = [].concat(filters['worktime-extent'] ?? []).filter(Boolean);
  let softWorktime = null;

  let body;
  if (wanted.length) {
    const relaxed = { ...filters };
    delete relaxed['worktime-extent'];
    body = await runQuery(buildQuery(relaxed, limit, offset));
    if ((body.total?.value ?? 0) <= RELAX_CAP) {
      softWorktime = new Set(wanted);
      filters = relaxed;
      console.log(`  omfattning bedöms här, inte i API:t (${body.total?.value} annonser att gå igenom)`);
    } else {
      // too large to page through — fall back to the strict query
      body = await runQuery(buildQuery(filters, limit, offset));
    }
  } else {
    body = await runQuery(buildQuery(filters, limit, offset));
  }
  // What the ladder had to throw away to get any hits at all. Returned
  // so the UI can say so: a requirement that is silently ignored looks
  // exactly like a filter that does not work.
  const dropped = [];

  for (const dropKeys of BROADENING_LADDER) {
    if ((body.total?.value ?? 0) > 0) break;
    const present = dropKeys.filter((k) => filters[k] !== undefined && filters[k] !== null);
    if (!present.length) continue;
    filters = { ...filters };
    for (const k of present) delete filters[k];
    dropped.push(...present);
    console.log(`  0 träffar — släpper ${present.join(', ')} och söker bredare`);
    // broadening changes the result set, so restart from the top
    body = await runQuery(buildQuery(filters, limit, 0));
    offset = 0;
  }

  const client = await pool.connect();
  try {
    const ids = [];
    let skipped = 0;
    for (const raw of body.hits || []) {
      // Drop only an explicit contradiction. An ad with no concept on
      // this axis is unknown, not disqualified, and stays in.
      if (softWorktime) {
        const got = raw.working_hours_type?.concept_id;
        if (got && !softWorktime.has(got)) { skipped += 1; continue; }
      }
      const r = await upsertAd(client, mapAd(raw));
      if (r?.id) ids.push(r.id);
    }
    const total = body.total?.value ?? null;
    console.log(`  ${ids.length} ads stored @ offset ${offset} (${total ?? '?'} total matches`
      + `${skipped ? `, ${skipped} med annan omfattning överhoppade` : ''})`);
    // `fetched` is how far the cursor moved through the API's result
    // set; `ids` is only what we kept. They used to be the same number,
    // and advancing by ids.length now would re-read half of every page
    // forever — the ads sorted out here still occupy their slot in the
    // API's ordering.
    return { ids, fetched: (body.hits || []).length, total, offset, dropped };
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// duplicate check: flag, never silently merge. Hiding a job
// the user hasn't seen is worse than showing a dupe.
// ------------------------------------------------------------
export async function findDuplicates(adId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.employer, b.deadline, app.status, app.sent_at
     FROM ads a
     JOIN ads b ON b.fingerprint = a.fingerprint AND b.id <> a.id
     LEFT JOIN applications app ON app.ad_id = b.id
     WHERE a.id = $1
     ORDER BY b.published_at DESC`,
    [adId]
  );
  return rows;
}
