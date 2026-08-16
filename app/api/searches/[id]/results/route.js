import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';

export const dynamic = 'force-dynamic';

// THE QUERY THAT FIXES CRM-E: application status is a JOIN
// (search_results view), never denormalized onto match_results.
//
// Paginated, because the candidate pool is now everything the criteria
// match — thousands of ads, not the first 20. The client scrolls; this
// route serves a page at a time and reports the true total so the UI
// can say "47 of 6334" honestly instead of implying the page is the set.
//
// `view` filters server-side so scrolling never has to fetch rows the
// user cannot see. apply_filter arrives here as a DISPLAY filter — on
// this branch nothing is scored until the user asks, so excluding ads
// at find time only hid jobs.
export async function GET(req, { params }) {
  const { id } = await params;
  const url = new URL(req.url);
  const view = url.searchParams.get('view') || 'alla';
  const apply = url.searchParams.get('apply') || 'any';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const viewSql = view === 'favoriter' ? 'r.shortlisted'
    : view === 'bedomda' ? 'r.score IS NOT NULL'
    : '(NOT r.shortlisted AND r.score IS NULL)';

  const applySql = apply === 'email' ? 'a.apply_email IS NOT NULL'
    : apply === 'external' ? '(a.apply_email IS NULL AND a.apply_url IS NOT NULL)'
    : 'true';

  const where = `r.search_id = $1 AND NOT r.suppressed AND ${viewSql} AND ${applySql}`;

  const { rows } = await pool.query(
    `SELECT r.*, m.matched, m.scored_at, m.lead_project_id, m.queue_rank,
       a.published_at, a.apply_email, a.apply_url, a.employer_type, a.fingerprint,
       a.raw->'occupation'->>'label'          AS occupation,
       a.raw->'working_hours_type'->>'label'  AS working_hours,
       a.raw->'employment_type'->>'label'     AS employment_type,
       left(regexp_replace(a.description, '\\s+', ' ', 'g'), 260) AS snippet,
       app.id AS application_id
     FROM search_results r
     JOIN match_results m ON m.search_id = r.search_id AND m.ad_id = r.ad_id
     JOIN ads a ON a.id = r.ad_id
     LEFT JOIN applications app ON app.ad_id = r.ad_id
     WHERE ${where}
     ORDER BY (r.score IS NULL), r.score DESC, m.queue_rank DESC NULLS LAST,
              a.published_at DESC NULLS LAST, r.ad_id
     LIMIT $2 OFFSET $3`,
    [id, limit, offset]
  );

  // Counts for all three tabs in one pass, so switching views never
  // shows a stale badge and the header can report honest totals.
  const { rows: [counts] } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE NOT r.shortlisted AND r.score IS NULL) AS hittade,
       count(*) FILTER (WHERE r.shortlisted)                         AS favoriter,
       count(*) FILTER (WHERE r.score IS NOT NULL)                   AS bedomda,
       count(*) FILTER (WHERE r.score_requested AND r.score IS NULL)  AS i_kon,
       count(*) FILTER (WHERE NOT r.shortlisted AND r.score IS NULL AND ${applySql}) AS hittade_filtrerade
     FROM search_results r
     JOIN ads a ON a.id = r.ad_id
     WHERE r.search_id = $1 AND NOT r.suppressed`,
    [id]
  );

  const total = view === 'favoriter' ? Number(counts.favoriter)
    : view === 'bedomda' ? Number(counts.bedomda)
    : Number(counts.hittade_filtrerade);

  return NextResponse.json({
    rows,
    offset,
    total,
    hasMore: offset + rows.length < total,
    counts: {
      // the badge must agree with the header — both reflect the active
      // display filter, or the tab promises rows the list won't show
      hittade: Number(counts.hittade_filtrerade),
      hittadeUtanFilter: Number(counts.hittade),
      favoriter: Number(counts.favoriter),
      bedomda: Number(counts.bedomda),
      iKon: Number(counts.i_kon),
    },
  });
}
