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
    // Four counters, because four things move independently:
    //   total      layer 1 found more ads
    //   scored     a requested verdict landed
    //   requested  the user asked for one (button must flip to "Bedöms")
    //   apps       an application was drafted or sent
    //
    // The last two are the ones this beacon used to miss. Sending writes
    // to `applications`, not `match_results`, so the list never learned
    // an ad had been applied to — the card kept offering "Skriv brev"
    // for something already in the employer's inbox until a reload.
    const { rows: [s] } = await pool.query(
      `SELECT count(*) AS total,
              count(m.score) AS scored,
              count(m.score_requested_at) AS requested,
              max(extract(epoch from m.scored_at)) AS last_scored,
              count(app.id) AS apps,
              max(extract(epoch from app.updated_at)) AS last_app
       FROM match_results m
       JOIN searches sr ON sr.id = m.search_id
       LEFT JOIN applications app ON app.ad_id = m.ad_id AND app.profile_id = sr.profile_id
       WHERE m.search_id = $1`, [searchId]
    );
    search = [
      s.total, s.scored, s.requested,
      Math.round(Number(s.last_scored) || 0),
      s.apps, Math.round(Number(s.last_app) || 0),
    ].join(':');
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
