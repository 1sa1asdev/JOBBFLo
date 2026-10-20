import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';
import { ägareAvAnnons, inteHittad } from '../../../../../src/auth.js';

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
  const profileId = await ägareAvAnnons(id);
  if (!profileId) return inteHittad('annonsen finns inte');
  // The caller's own fact. It used to be a column on the shared ad, so
  // one user's click showed as opened for everyone.
  const { rows: [ad] } = await pool.query(
    `INSERT INTO ad_opens (profile_id, ad_id, opened_at)
     SELECT $2, a.id, now() FROM ads a WHERE a.id = $1 AND a.apply_url IS NOT NULL
     ON CONFLICT (profile_id, ad_id) DO UPDATE SET opened_at = now()
     RETURNING ad_id AS id, opened_at AS apply_url_opened_at`,
    [id, profileId]
  );
  if (!ad) {
    return NextResponse.json({ error: 'annonsen har ingen länk' }, { status: 404 });
  }
  return NextResponse.json(ad);
}
