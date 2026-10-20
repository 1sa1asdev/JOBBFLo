import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { findDuplicates } from '../../../../src/fetchJobs.js';
import { ägareAvAnnons, inteHittad } from '../../../../src/auth.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  const searchId = new URL(req.url).searchParams.get('search');
  // The ad is shared; everything below it is someone's. Which searches
  // found it, whether it was applied to and what the checklist said are
  // the caller's own — another user's checklist quotes their CV.
  const profileId = await ägareAvAnnons(id);
  if (!profileId) return inteHittad('annonsen finns inte');

  const { rows: [ad] } = await pool.query(`SELECT * FROM ads WHERE id = $1`, [id]);
  if (!ad) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { rows: [match] } = await pool.query(
    searchId
      ? `SELECT m.*, p.name AS lead_project_name FROM match_results m
         JOIN searches s ON s.id = m.search_id AND s.profile_id = $3
         LEFT JOIN projects p ON p.id = m.lead_project_id
         WHERE m.ad_id = $1 AND m.search_id = $2`
      : `SELECT m.*, p.name AS lead_project_name FROM match_results m
         JOIN searches s ON s.id = m.search_id AND s.profile_id = $2
         LEFT JOIN projects p ON p.id = m.lead_project_id
         -- NULLS LAST is load-bearing. An ad can sit in several
         -- searches: judged in one, an untouched candidate in another.
         -- Postgres sorts NULLs FIRST on DESC, so a plain score DESC
         -- picked the unjudged row and the ad opened with no verdict
         -- and no matched quotes — for 83 ads here, each of which had
         -- a score someone had paid for.
         WHERE m.ad_id = $1 ORDER BY m.score DESC NULLS LAST LIMIT 1`,
    searchId ? [id, searchId, profileId] : [id, profileId]
  );

  // soft-dedupe: same fingerprint elsewhere → flag for the user, never merge
  const duplicates = await findDuplicates(id, profileId);

  const { rows: [application] } = await pool.query(
    `SELECT * FROM applications WHERE ad_id = $1 AND profile_id = $2`, [id, profileId]
  );

  // The rows the score was computed from. Keyed to the verdict the UI
  // is showing (check_cv_key), so an old verdict opens the checklist it
  // was actually made from rather than a newer one against another CV.
  // ad_checks is keyed on (ad, CV), not on a user. The fallback used to
  // be "the newest checklist for this ad" — which, with more than one
  // user, is whoever graded it last, CV quotes and all. It is now the
  // newest one made for one of the caller's own searches.
  const { rows: [check] } = await pool.query(
    match?.check_cv_key
      ? `SELECT * FROM ad_checks WHERE ad_id = $1 AND cv_key = $2`
      : `SELECT c.* FROM ad_checks c
         WHERE c.ad_id = $1 AND c.cv_key IN (
           SELECT m.check_cv_key FROM match_results m
           JOIN searches s ON s.id = m.search_id AND s.profile_id = $2
           WHERE m.ad_id = $1 AND m.check_cv_key IS NOT NULL)
         ORDER BY c.checked_at DESC LIMIT 1`,
    match?.check_cv_key ? [id, match.check_cv_key] : [id, profileId]
  );

  return NextResponse.json({ ad, match, duplicates, application, check });
}
