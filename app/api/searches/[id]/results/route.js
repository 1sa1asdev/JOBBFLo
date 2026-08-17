import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';

export const dynamic = 'force-dynamic';

// THE QUERY THAT FIXES CRM-E: application status is a JOIN
// (search_results view), never denormalized onto match_results.
//
// Paginated, because the candidate pool is now everything the criteria
// match — thousands of ads, not the first 20. The client scrolls; this
// route serves a page at a time and reports the true total so the UI
// can say "60 of 246" honestly instead of implying the page is the set.
//
// `view`, `apply` and `maxkm` all filter server-side, so scrolling never
// fetches rows the user cannot see and "within 5 km" means within 5 km
// of the whole candidate pool, not of the page already loaded.

// Haversine between the home coordinates ($4, $5) and the ad's own.
// Pure arithmetic over two coordinate pairs — no model, no geocoding
// service, no tile server. It lives in SQL so distance can sort and
// filter thousands of candidates without shipping them to the client.
// Built with explicit parameter indices because the two queries below
// bind their arguments in different orders — hardcoding $4/$5 silently
// produced a filter that referenced parameters the counts query never
// supplied.
const distanceKm = (latIdx, lonIdx) => `
  6371 * 2 * asin(sqrt(
    power(sin(radians(a.lat - $${latIdx}) / 2), 2)
    + cos(radians($${latIdx})) * cos(radians(a.lat))
      * power(sin(radians(a.lon - $${lonIdx}) / 2), 2)
  ))`;

export async function GET(req, { params }) {
  const { id } = await params;
  const url = new URL(req.url);
  const view = url.searchParams.get('view') || 'alla';
  const apply = url.searchParams.get('apply') || 'any';
  const sort = url.searchParams.get('sort') || 'score';
  const maxKm = Number(url.searchParams.get('maxkm')) || null;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  // Where the user travels from. With no home set there are simply no
  // distances — the field is null rather than guessed at.
  const { rows: [me] } = await pool.query(
    `SELECT home_lat, home_lon, home_label FROM profile LIMIT 1`);
  const hasHome = me?.home_lat != null && me?.home_lon != null;

  const viewSql = view === 'favoriter' ? 'r.shortlisted'
    : view === 'bedomda' ? 'r.score IS NOT NULL'
    : '(NOT r.shortlisted AND r.score IS NULL)';

  const applySql = apply === 'email' ? 'a.apply_email IS NOT NULL'
    : apply === 'external' ? '(a.apply_email IS NULL AND a.apply_url IS NOT NULL)'
    : 'true';

  // An ad with no coordinates is kept, never silently dropped by a
  // distance filter — "unknown distance" is not "too far", and hiding a
  // job because Arbetsförmedlingen omitted a postcode would be the
  // worst kind of silent loss.
  // rows query binds: $1 id, $2 limit, $3 offset, $4 lat, $5 lon
  const rowDist = distanceKm(4, 5);
  const distSql = hasHome ? rowDist : 'NULL::double precision';
  const rowKmFilter = hasHome && maxKm
    ? ` AND (a.lat IS NULL OR ${rowDist} <= ${Number(maxKm)})`
    : '';

  const orderSql = sort === 'distance' && hasHome
    ? `${rowDist} ASC NULLS LAST, r.score DESC NULLS LAST`
    : `(r.score IS NULL), r.score DESC, m.queue_rank DESC NULLS LAST,
       a.published_at DESC NULLS LAST`;

  const where = `r.search_id = $1 AND NOT r.suppressed AND ${viewSql} AND ${applySql}${rowKmFilter}`;
  const args = [id, limit, offset, me?.home_lat ?? 0, me?.home_lon ?? 0];

  // counts query binds: $1 id, $2 lat, $3 lon
  const countKmFilter = hasHome && maxKm
    ? ` AND (a.lat IS NULL OR ${distanceKm(2, 3)} <= ${Number(maxKm)})`
    : '';

  const { rows } = await pool.query(
    `SELECT r.*, m.matched, m.scored_at, m.lead_project_id, m.queue_rank,
       a.published_at, a.apply_email, a.apply_url, a.employer_type, a.fingerprint,
       a.lat, a.lon,
       a.raw->'workplace_address'->>'street_address' AS street,
       a.raw->'workplace_address'->>'city'           AS city,
       a.raw->'occupation'->>'label'                 AS occupation,
       a.raw->'working_hours_type'->>'label'         AS working_hours,
       a.raw->'employment_type'->>'label'            AS employment_type,
       left(regexp_replace(a.description, '\\s+', ' ', 'g'), 260) AS snippet,
       round((${distSql})::numeric, 1) AS distance_km,
       -- judged before the criteria last changed: the verdict stands,
       -- but it answered a different question
       (m.scored_at IS NOT NULL AND sr.criteria_changed_at IS NOT NULL
        AND m.scored_at < sr.criteria_changed_at) AS stale,
       app.id AS application_id
     FROM search_results r
     JOIN match_results m ON m.search_id = r.search_id AND m.ad_id = r.ad_id
     JOIN ads a ON a.id = r.ad_id
     JOIN searches sr ON sr.id = r.search_id
     LEFT JOIN applications app ON app.ad_id = r.ad_id
     WHERE ${where}
     ORDER BY ${orderSql}, r.ad_id
     LIMIT $2 OFFSET $3`,
    args
  );

  // Counts for all three tabs in one pass, so switching views never
  // shows a stale badge and the header can report honest totals.
  const { rows: [counts] } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE NOT r.shortlisted AND r.score IS NULL) AS hittade,
       count(*) FILTER (WHERE r.shortlisted)                         AS favoriter,
       count(*) FILTER (WHERE r.score IS NOT NULL)                   AS bedomda,
       count(*) FILTER (WHERE r.score_requested AND r.score IS NULL)  AS i_kon,
       count(*) FILTER (WHERE NOT r.shortlisted AND r.score IS NULL
                          AND ${applySql}${countKmFilter})           AS hittade_filtrerade
     FROM search_results r
     JOIN ads a ON a.id = r.ad_id
     WHERE r.search_id = $1 AND NOT r.suppressed`,
    // Bind lat/lon ONLY when the filter above actually references them.
    // Postgres rejects a bind carrying more parameters than the
    // statement has placeholders, so passing them unconditionally made
    // every request without ?maxkm a 500 — the third time this exact
    // mistake has appeared in this file's neighbourhood.
    countKmFilter ? [id, me.home_lat, me.home_lon] : [id]
  );

  const total = view === 'favoriter' ? Number(counts.favoriter)
    : view === 'bedomda' ? Number(counts.bedomda)
    : Number(counts.hittade_filtrerade);

  return NextResponse.json({
    rows,
    offset,
    total,
    hasMore: offset + rows.length < total,
    home: hasHome ? { label: me.home_label, lat: me.home_lat, lon: me.home_lon } : null,
    counts: {
      // the badge must agree with the header — both reflect the active
      // display filters, or the tab promises rows the list won't show
      hittade: Number(counts.hittade_filtrerade),
      hittadeUtanFilter: Number(counts.hittade),
      favoriter: Number(counts.favoriter),
      bedomda: Number(counts.bedomda),
      iKon: Number(counts.i_kon),
    },
  });
}
