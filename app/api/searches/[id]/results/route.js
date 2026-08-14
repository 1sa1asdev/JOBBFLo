import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';

export const dynamic = 'force-dynamic';

// THE QUERY THAT FIXES CRM-E: application status is a JOIN
// (search_results view), never denormalized onto match_results.
export async function GET(_req, { params }) {
  const { id } = await params;
  // Includes rows the LLM has not reached yet (score NULL). Those are
  // real ads found by layer 1 — showing them straight away is the
  // point of the queue, and `pending` lets the UI tell "not judged
  // yet" apart from "judged as a 0".
  //
  // Scored rows sort first by score, then the queue in the order it
  // will actually drain, so a card never jumps position when its
  // score lands unless the score itself moves it.
  const { rows } = await pool.query(
    `SELECT r.*, m.matched, m.scored_at, m.lead_project_id, m.queue_rank,
       a.published_at, a.apply_email, a.apply_url, a.employer_type, a.fingerprint,
       app.id AS application_id
     FROM search_results r
     JOIN match_results m ON m.search_id = r.search_id AND m.ad_id = r.ad_id
     JOIN ads a ON a.id = r.ad_id
     LEFT JOIN applications app ON app.ad_id = r.ad_id
     WHERE r.search_id = $1
     ORDER BY (r.score IS NULL), r.score DESC, m.queue_rank DESC NULLS LAST,
              a.published_at DESC NULLS LAST`,
    [id]
  );
  return NextResponse.json(rows);
}
