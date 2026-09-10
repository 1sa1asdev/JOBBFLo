import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { findDuplicates } from '../../../../src/fetchJobs.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  const searchId = new URL(req.url).searchParams.get('search');

  const { rows: [ad] } = await pool.query(`SELECT * FROM ads WHERE id = $1`, [id]);
  if (!ad) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { rows: [match] } = await pool.query(
    searchId
      ? `SELECT m.*, p.name AS lead_project_name FROM match_results m
         LEFT JOIN projects p ON p.id = m.lead_project_id
         WHERE m.ad_id = $1 AND m.search_id = $2`
      : `SELECT m.*, p.name AS lead_project_name FROM match_results m
         LEFT JOIN projects p ON p.id = m.lead_project_id
         -- NULLS LAST is load-bearing. An ad can sit in several
         -- searches: judged in one, an untouched candidate in another.
         -- Postgres sorts NULLs FIRST on DESC, so a plain score DESC
         -- picked the unjudged row and the ad opened with no verdict
         -- and no matched quotes — for 83 ads here, each of which had
         -- a score someone had paid for.
         WHERE m.ad_id = $1 ORDER BY m.score DESC NULLS LAST LIMIT 1`,
    searchId ? [id, searchId] : [id]
  );

  // soft-dedupe: same fingerprint elsewhere → flag for the user, never merge
  const duplicates = await findDuplicates(id);

  const { rows: [application] } = await pool.query(
    `SELECT * FROM applications WHERE ad_id = $1`, [id]
  );

  return NextResponse.json({ ad, match, duplicates, application });
}
