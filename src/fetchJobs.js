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
     RETURNING id, (xmax = 0) AS inserted`,
    [a.source, a.external_id, a.fingerprint, a.title, a.employer, a.employer_type,
     a.municipality, a.region, a.description, a.apply_email, a.apply_url,
     a.ats_vendor, a.published_at, a.deadline, a.removed_at, a.raw]
  );
  return rows[0];
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

    let created = 0, updated = 0, removed = 0, skipped = 0;
    for (const raw of ads) {
      try {
        // removed ads come through the stream stripped of everything but
        // id + removed flag — never upsert those, just mark ours removed
        if (raw.removed) {
          await client.query(
            `UPDATE ads SET removed_at = COALESCE(removed_at, $2)
             WHERE source = 'platsbanken' AND external_id = $1`,
            [String(raw.id), raw.removed_date || new Date().toISOString()]
          );
          removed++;
          continue;
        }
        if (!raw.headline) { skipped++; continue; }
        const { inserted } = await upsertAd(client, mapAd(raw));
        if (inserted) created++;
        else updated++;
      } catch (err) {
        skipped++;
        console.error(`  !! ad ${raw?.id}: ${err.message}`);
      }
    }

    await client.query(
      `UPDATE poll_state SET cursor_ts = now(), last_run_at = now() WHERE key = 'jobstream'`
    );

    console.log(`  +${created} new  ~${updated} updated  -${removed} removed  (${skipped} skipped)`);
    return { created, updated, removed, skipped, total: ads.length };
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// JobSearch: used for the FIRST fill of a new search (backfill),
// since JobStream only gives you changes going forward.
// ------------------------------------------------------------
export async function backfillSearch(rawFilters = {}, limit = 100) {
  // names -> taxonomy concept IDs. Skipping this silently returns
  // zero hits (the API doesn't error on an unknown name).
  const filters = await resolveFilters(rawFilters);

  const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });

  if (filters.q) params.set('q', filters.q);
  for (const key of ['occupation-field', 'occupation-group', 'municipality', 'region',
                     'employment-type', 'experience-required', 'remote', 'published-after']) {
    const val = filters[key];
    if (val === undefined || val === null) continue;
    for (const v of [].concat(val)) params.append(key, String(v));
  }

  const url = `${JOBSEARCH}?${params}`;
  console.log(`→ ${url}`);

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JobSearch ${res.status}: ${await res.text()}`);

  const body = await res.json();
  const client = await pool.connect();
  try {
    const ids = [];
    for (const raw of body.hits || []) {
      const { id } = await upsertAd(client, mapAd(raw));
      ids.push(id);
    }
    console.log(`  ${ids.length} ads stored (${body.total?.value ?? '?'} total matches)`);
    return ids;
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
