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
    // Every counter above lives in match_results, and that was the gap:
    // editing the criteria, the hard requirement or the places changes
    // the SEARCH, not those counts. When the new filters happened to find
    // a similar number of ads the beacon never moved, the list never
    // refetched, and a saved change looked like one that did not save.
    //
    // `rules` hashes everything the user can edit, so any of them moves
    // the version. fetch_offset and fetch_total are here for a second
    // reason: the header's "söker igenom 900 av 1172" reads them off the
    // search object, so without them the progress sat frozen while the
    // sweep ran underneath it.
    //
    // Driven off `searches` rather than match_results so a search with no
    // candidates yet still reports — which is when the user watches hardest.
    const { rows: [s] } = await pool.query(
      `SELECT
         (SELECT count(*) FROM match_results m WHERE m.search_id = sr.id) AS total,
         (SELECT count(score) FROM match_results m WHERE m.search_id = sr.id) AS scored,
         (SELECT count(score_requested_at) FROM match_results m WHERE m.search_id = sr.id) AS requested,
         (SELECT max(extract(epoch from scored_at)) FROM match_results m WHERE m.search_id = sr.id) AS last_scored,
         (SELECT count(*) FROM match_results m
            JOIN applications app ON app.ad_id = m.ad_id AND app.profile_id = sr.profile_id
          WHERE m.search_id = sr.id) AS apps,
         (SELECT max(extract(epoch from app.updated_at)) FROM match_results m
            JOIN applications app ON app.ad_id = m.ad_id AND app.profile_id = sr.profile_id
          WHERE m.search_id = sr.id) AS last_app,
         sr.fetch_offset, sr.fetch_total, (sr.fetch_done_at IS NOT NULL) AS swept,
         md5(coalesce(sr.criteria_text, '')
           || coalesce(sr.api_filters::text, '')
           || coalesce(sr.must_criteria, '')
           || coalesce(sr.location::text, '')
           || coalesce(sr.auto_apply_min_score::text, '')) AS rules
       FROM searches sr WHERE sr.id = $1`, [searchId]
    );
    search = s ? [
      s.total, s.scored, s.requested,
      Math.round(Number(s.last_scored) || 0),
      s.apps, Math.round(Number(s.last_app) || 0),
      s.fetch_offset, s.fetch_total, s.swept, s.rules,
    ].join(':') : null;
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
