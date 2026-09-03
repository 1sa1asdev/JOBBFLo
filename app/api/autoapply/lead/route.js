import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { fingerprint } from '../../../../src/fetchJobs.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// A lead the user found themselves.
//
// Arbetsförmedlingen is not where every job lives. A company you know is
// hiring, an address off a careers page, someone a friend named — none
// of it reaches the API, and until now none of it could reach a
// campaign either.
//
// Stored as an ordinary ad with source = 'manual' rather than a separate
// table. Everything downstream — the send path, the per-address dedupe,
// one application per ad, the inbox threading — already works on ads,
// and a parallel concept would need all of it rebuilt and would drift.
// external_id stays NULL so the UNIQUE(source, external_id) index that
// merges API reposts does not apply to hand-typed rows.
//
// The lead skips scoring, and that is the interesting decision. A score
// exists to judge whether an ad the MACHINE found is worth writing to.
// A lead typed in by hand has already been judged, by the person whose
// letters these are — asking a model to second-guess that would spend
// tokens to override the user.
// ------------------------------------------------------------
export async function POST(req) {
  const { searchId, employer, email, title, note, municipality } = await req.json();

  if (!searchId) return NextResponse.json({ error: 'searchId krävs' }, { status: 400 });

  const addr = String(email || '').trim().toLowerCase();
  // Deliberately loose: a real address this rejects is worse than a
  // typo it lets through, because the typo bounces visibly and the
  // rejection just looks broken.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
    return NextResponse.json({ error: 'ogiltig mejladress' }, { status: 400 });
  }
  const emp = String(employer || '').trim();
  if (!emp) return NextResponse.json({ error: 'arbetsgivare krävs' }, { status: 400 });

  const { rows: [search] } = await pool.query(
    `SELECT s.id, s.profile_id FROM searches s
     WHERE s.id = $1 AND s.deleted_at IS NULL AND s.campaign_created_at IS NOT NULL`,
    [searchId]
  );
  if (!search) return NextResponse.json({ error: 'kampanjen finns inte' }, { status: 404 });

  // The same guard the campaign applies to API ads. Catching it here
  // means the user is told while adding, rather than watching the lead
  // sit in the queue being skipped for a reason only the log explains.
  const { rows: [clash] } = await pool.query(
    `SELECT ads.employer, a.sent_at FROM applications a
     JOIN ads ON ads.id = a.ad_id
     WHERE a.profile_id = $1 AND a.sent_to IS NOT NULL AND lower(a.sent_to) = $2`,
    [search.profile_id, addr]
  );
  if (clash) {
    return NextResponse.json({
      error: `${addr} har redan fått en ansökan (${clash.employer}`
        + `${clash.sent_at ? `, ${new Date(clash.sent_at).toLocaleDateString('sv-SE')}` : ''}).`,
    }, { status: 409 });
  }

  const headline = String(title || '').trim() || `Spontanansökan — ${emp}`;
  const body = String(note || '').trim()
    || `Lead tillagd för hand. Ingen annonstext finns — kampanjbrevet skickas som det är.`;

  const { rows: [ad] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, employer_type,
       description, apply_email, municipality, published_at)
     VALUES ('manual', NULL, $1, $2, $3, 'private', $4, $5, $6, now())
     RETURNING id, title, employer, apply_email`,
    [fingerprint({ employer: emp, title: headline, municipality: municipality || null }),
     headline, emp, body, addr, String(municipality || '').trim() || null]
  );

  // Into the campaign's queue as a candidate. score stays NULL — see
  // candidatesFor, which lets a manual lead through without one.
  await pool.query(
    `INSERT INTO match_results (search_id, ad_id, queued_at)
     VALUES ($1, $2, now())
     ON CONFLICT (search_id, ad_id) DO NOTHING`,
    [searchId, ad.id]
  );

  return NextResponse.json(ad, { status: 201 });
}
