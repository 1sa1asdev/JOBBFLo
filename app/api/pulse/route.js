import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// Change beacon. One tiny query the UI can poll often; the
// expensive list/thread fetches only run when the version
// actually moves. Keeps "reply lands -> user sees it" inside
// CLAUDE.md's 15-30s budget without hammering Postgres.
// ------------------------------------------------------------
export async function GET(req) {
  const searchId = new URL(req.url).searchParams.get('search');

  const { rows: [v] } = await pool.query(
    `SELECT
       (SELECT count(*) FROM email_messages)     AS msgs,
       (SELECT max(extract(epoch from created_at)) FROM email_messages) AS last_msg,
       (SELECT count(*) FROM suggested_replies WHERE NOT dismissed) AS suggestions,
       (SELECT max(extract(epoch from updated_at)) FROM applications) AS last_app,
       (SELECT count(*) FROM applications WHERE status <> 'drafted') AS sent_apps`
  );

  let search = null;
  if (searchId) {
    // Two counters, because queueing and scoring move independently:
    // `total` jumps when layer 1 finds ads, `scored` ticks up one at a
    // time as the queue drains. A score arrives as an UPDATE, so
    // counting rows alone would never notice it — and count(score)
    // skips NULLs, which is exactly the pending set.
    const { rows: [s] } = await pool.query(
      `SELECT count(*) AS total, count(score) AS scored,
              max(extract(epoch from scored_at)) AS last_scored
       FROM match_results WHERE search_id = $1`, [searchId]
    );
    search = `${s.total}:${s.scored}:${Math.round(Number(s.last_scored) || 0)}`;
  }

  // one opaque string — the client only cares whether it changed
  const version = [
    v.msgs, Math.round(Number(v.last_msg) || 0),
    v.suggestions, Math.round(Number(v.last_app) || 0), v.sent_apps,
  ].join(':');

  return NextResponse.json({ version, search }, {
    headers: { 'cache-control': 'no-store' },
  });
}
