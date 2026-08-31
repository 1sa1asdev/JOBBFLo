import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// "I applied through the ad's link."
//
// This is NOT a send. Nothing leaves the machine here — the user has
// already applied somewhere we cannot see, and is telling the app so it
// can start tracking. That is why it lives beside the send route rather
// than inside mailer.js: the one file that sends must stay the one file
// that sends.
//
// Most of the pool needs this. 90 of 147 favourites publish no
// apply_email, so for the majority of jobs the letter was the end of
// the road: no deadline warning, no follow-up, no record that the
// application happened at all.
// ------------------------------------------------------------
export async function POST(req, { params }) {
  const { id } = await params;

  const { rows: [app] } = await pool.query(
    `SELECT a.status, ads.apply_url, ads.apply_email
     FROM applications a JOIN ads ON ads.id = a.ad_id
     WHERE a.id = $1`, [id]
  );
  if (!app) return NextResponse.json({ error: 'ansökan finns inte' }, { status: 404 });

  // Same guard as sending: an application happens once (UNIQUE(ad_id)),
  // and re-marking one would move sent_at and reset the follow-up clock.
  if (app.status !== 'drafted') {
    return NextResponse.json({ error: 'redan markerad som ansökt' }, { status: 409 });
  }

  const { rows: [updated] } = await pool.query(
    `UPDATE applications SET
       status = 'sent', sent_by = 'external', sent_at = now(),
       applied_via_url = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, status, sent_by, sent_at, applied_via_url`,
    [id, app.apply_url || null]
  );

  return NextResponse.json(updated);
}
