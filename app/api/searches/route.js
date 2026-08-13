import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';
import { parseCriteria, scoreSearch } from '../../../src/score.js';
import { backfillSearch } from '../../../src/fetchJobs.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { rows } = await pool.query(
    `SELECT s.*,
       (SELECT count(*) FROM match_results m WHERE m.search_id = s.id AND m.score >= 60) AS match_count,
       (SELECT count(*) FROM search_results r WHERE r.search_id = s.id AND r.application_status = 'drafted') AS draft_count,
       (SELECT count(*) FROM search_results r WHERE r.search_id = s.id AND r.application_status IN ('sent','replied','interview')) AS sent_count
     FROM searches s
     WHERE s.deleted_at IS NULL
     ORDER BY s.created_at`
  );
  return NextResponse.json(rows);
}

export async function POST(req) {
  const { name, criteria } = await req.json();
  if (!criteria?.trim()) {
    return NextResponse.json({ error: 'criteria krävs' }, { status: 400 });
  }

  const { rows: [profile] } = await pool.query(`SELECT id FROM profile LIMIT 1`);
  if (!profile) return NextResponse.json({ error: 'ingen profil — kör db:seed' }, { status: 400 });

  let filters = {};
  let parseError = null;
  try {
    ({ filters } = await parseCriteria(criteria));
  } catch (err) {
    parseError = err.message; // no API key / model error — search still gets created
  }

  const { rows: [search] } = await pool.query(
    `INSERT INTO searches (profile_id, name, criteria_text, api_filters)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [profile.id, name?.trim() || criteria.slice(0, 60), criteria, JSON.stringify(filters)]
  );

  await pool.query(
    `INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'user', $2)`,
    [search.id, criteria]
  );
  await pool.query(
    `INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'assistant', $2)`,
    [search.id, parseError
      ? `Kunde inte tolka kriterierna mot API:t (${parseError}). Sökningen är sparad — försök igen via chatten.`
      : `Filter satta via JobSearch API: ${Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(' · ') || 'inga — bred sökning'}. Resten bedöms mot annonstexten.`]
  );

  // backfill + first scoring pass in the background; UI polls results
  if (!parseError) {
    (async () => {
      try {
        await backfillSearch(filters, 50);
        await scoreSearch(search.id, { limit: 20 });
      } catch (err) {
        console.error(`backfill ${search.id}:`, err.message);
      }
    })();
  }

  return NextResponse.json(search, { status: 201 });
}
