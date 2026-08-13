import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';

export const dynamic = 'force-dynamic';

// THE QUERY THAT FIXES CRM-E: application status is a JOIN
// (search_results view), never denormalized onto match_results.
export async function GET(_req, { params }) {
  const { id } = await params;
  const { rows } = await pool.query(
    `SELECT r.*, m.matched, m.scored_at, m.lead_project_id,
       a.published_at, a.apply_email, a.apply_url, a.employer_type, a.fingerprint,
       app.id AS application_id
     FROM search_results r
     JOIN match_results m ON m.search_id = r.search_id AND m.ad_id = r.ad_id
     JOIN ads a ON a.id = r.ad_id
     LEFT JOIN applications app ON app.ad_id = r.ad_id
     WHERE r.search_id = $1
     ORDER BY r.score DESC`,
    [id]
  );
  return NextResponse.json(rows);
}
