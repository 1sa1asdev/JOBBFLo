import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// Favouriting. Free by design — this endpoint never calls a model
// and never enqueues one. It records that the user found an ad
// interesting, nothing more.
//
// Scoring is a separate, explicit act: POST .../score with the ad
// ids you actually want judged. Keeping them apart is the whole
// point — a favourites tab that quietly scored on every star would
// reintroduce the cost it exists to avoid.
// ------------------------------------------------------------
export async function PATCH(req, { params }) {
  const { id } = await params;
  const { ad_id, ad_ids, shortlisted } = await req.json();

  const ids = ad_ids || (ad_id ? [ad_id] : []);
  if (!ids.length) {
    return NextResponse.json({ error: 'ad_id eller ad_ids krävs' }, { status: 400 });
  }

  const { rowCount } = await pool.query(
    `UPDATE match_results
     SET shortlisted_at = CASE WHEN $3 THEN COALESCE(shortlisted_at, now()) ELSE NULL END
     WHERE search_id = $1 AND ad_id = ANY($2::uuid[])`,
    [id, ids, shortlisted !== false]
  );

  return NextResponse.json({ updated: rowCount, shortlisted: shortlisted !== false });
}
