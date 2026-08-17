import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';
import { scorePending } from '../../../../../src/score.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// The ONLY route that authorises spend on scoring.
//
// It takes explicit ad ids — never "score everything". Marking
// score_requested_at is what src/score.js keys on, so an ad that
// never came through here is never sent to a model, no matter how
// long it sits in the candidate pool or the favourites tab.
//
// Returns immediately with a count; the scoring drains behind the
// response and the cards fill in as verdicts land.
// ------------------------------------------------------------
export async function POST(req, { params }) {
  const { id } = await params;
  const { ad_ids, rescore = false } = await req.json();

  if (!Array.isArray(ad_ids) || !ad_ids.length) {
    return NextResponse.json(
      { error: 'ad_ids krävs — bedömning begärs alltid för specifika annonser' },
      { status: 400 }
    );
  }

  // Only mark ads that are not already scored. Re-requesting a scored
  // ad is a no-op rather than a second charge for the same verdict.
  const { rows } = await pool.query(
    `UPDATE match_results
     SET score_requested_at = now(),
         shortlisted_at     = COALESCE(shortlisted_at, now()),
         -- re-scoring means judging again, so the old verdict has to go;
         -- src/score.js only picks up rows where score IS NULL
         score   = CASE WHEN $3 THEN NULL ELSE score END,
         summary = CASE WHEN $3 THEN NULL ELSE summary END
     WHERE search_id = $1 AND ad_id = ANY($2::uuid[])
       AND ($3::boolean OR score IS NULL)
     RETURNING ad_id`,
    [id, ad_ids, rescore]
  );

  if (rows.length) {
    // deliberately not awaited — the response returns now, the worker's
    // drain tick picks up anything this process doesn't finish
    scorePending(id, { limit: rows.length })
      .catch((e) => console.error(`bedömning ${id}:`, e.message));
  }

  return NextResponse.json({ requested: rows.length, skipped: ad_ids.length - rows.length });
}
