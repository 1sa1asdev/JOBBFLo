import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';
import { parseCriteria, scanSearch } from '../../../src/score.js';

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
  const { name, criteria, apply_filter } = await req.json();
  if (!criteria?.trim()) {
    return NextResponse.json({ error: 'criteria krävs' }, { status: 400 });
  }

  if (apply_filter != null && !['email', 'any', 'external'].includes(apply_filter)) {
    return NextResponse.json({ error: `okänt ansökningssätt: ${apply_filter}` }, { status: 400 });
  }

  const { rows: [profile] } = await pool.query(`SELECT id FROM profile LIMIT 1`);
  if (!profile) return NextResponse.json({ error: 'ingen profil — kör db:seed' }, { status: 400 });

  let filters = {};
  let parseError = null;
  try {
    ({ filters } = await parseCriteria(criteria));
  } catch (err) {
    // no API key / model error — fall back to plain free-text search so
    // the real JobSearch API still gets queried; layer 2 waits for a key
    parseError = err.message;
    filters = { q: criteria.slice(0, 200) };
  }

  const { rows: [search] } = await pool.query(
    // Set before the first scan on purpose: asking afterwards would
    // mean that scan had already paid to judge ads the answer excludes.
    `INSERT INTO searches (profile_id, name, criteria_text, api_filters, apply_filter)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [profile.id, name?.trim() || criteria.slice(0, 60), criteria, JSON.stringify(filters),
     apply_filter || null]
  );

  await pool.query(
    `INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'user', $2)`,
    [search.id, criteria]
  );
  await pool.query(
    `INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'assistant', $2)`,
    [search.id, parseError
      ? `AI-tolkning otillgänglig (${parseError}) — söker med fritext mot JobSearch API istället. Annonser hämtas, men poängsättning kräver en AI-nyckel (OPENROUTER_API_KEY i .env).`
      : `Filter satta via JobSearch API: ${Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(' · ') || 'inga — bred sökning'}. Resten bedöms mot annonstexten.`]
  );

  // Queue the first batch before responding — roughly a second of
  // Arbetsförmedlingen plus local prefiltering — so the new search
  // already has jobs in it when the UI switches to it. Scoring
  // drains behind the response.
  try {
    await scanSearch(search.id, { limit: 20, background: true });
  } catch (err) {
    console.error(`scan ${search.id}:`, err.message);
  }

  return NextResponse.json(search, { status: 201 });
}
