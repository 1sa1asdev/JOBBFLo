import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';

export const dynamic = 'force-dynamic';

// The user opened this ad's application link from inside the app.
//
// Recorded because it is the only part of a link-only application the
// app can observe — everything after this happens on the employer's
// site. It does not prove an application was submitted, and nothing
// here pretends it does; it is what gates the "✓ Sökt" button, which
// otherwise let one stray click file a job as applied to that the user
// had never opened.
export async function POST(_req, { params }) {
  const { id } = await params;
  const { rows: [ad] } = await pool.query(
    `UPDATE ads SET apply_url_opened_at = now()
     WHERE id = $1 AND apply_url IS NOT NULL
     RETURNING id, apply_url_opened_at`,
    [id]
  );
  if (!ad) {
    return NextResponse.json({ error: 'annonsen har ingen länk' }, { status: 404 });
  }
  return NextResponse.json(ad);
}
