import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';
import { aktivProfilId, ägareAvSökning } from '../../../src/auth.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// Change beacon. One tiny query the UI can poll often; the
// expensive list/thread fetches only run when the version
// actually moves. Keeps "reply lands -> user sees it" inside
// CLAUDE.md's 15-30s budget without hammering Postgres.
// ------------------------------------------------------------
//
// One request answers every part of the screen (lib/beacon.js): the
// global version always, and an area only when a mounted view asks for
// it —
//   ?search=<id>     the result list of that search
//   ?delar=kampanjer the campaign cards (Auto-ansökan)
//   ?adresser=<id>   the address finder for that campaign
// so the campaign hash, which reads several tables, is not paid for by
// someone looking at their inbox.
export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const searchId = params.get('search');
  const delar = new Set((params.get('delar') || '').split(',').filter(Boolean));
  const adresserFör = params.get('adresser');
  const profileId = await aktivProfilId();

  const { rows: [v] } = await pool.query(
    `SELECT
       (SELECT count(*) FROM email_messages em
          JOIN applications a ON a.id = em.application_id AND a.profile_id = $1) AS msgs,
       (SELECT max(extract(epoch from em.created_at)) FROM email_messages em
          JOIN applications a ON a.id = em.application_id AND a.profile_id = $1) AS last_msg,
       (SELECT count(*) FROM suggested_replies sr
          JOIN applications a ON a.id = sr.application_id AND a.profile_id = $1
        WHERE NOT sr.dismissed) AS suggestions,
       (SELECT max(extract(epoch from updated_at)) FROM applications WHERE profile_id = $1) AS last_app,
       (SELECT count(*) FROM applications WHERE status <> 'drafted' AND profile_id = $1) AS sent_apps`,
    [profileId]
  );

  // A search that is not the caller's gets no beacon at all, the same as
  // one that does not exist — not even its row counts.
  let search = null;
  if (searchId && await ägareAvSökning(searchId)) {
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
       FROM searches sr WHERE sr.id = $1 AND sr.profile_id = $2`, [searchId, profileId]
    );
    search = s ? [
      s.total, s.scored, s.requested,
      Math.round(Number(s.last_scored) || 0),
      s.apps, Math.round(Number(s.last_app) || 0),
      s.fetch_offset, s.fetch_total, s.swept, s.rules,
    ].join(':') : null;
  }

  // The campaign cards (GET /api/autoapply) read the campaign's settings,
  // its grades, what it sent, the address hunt and the date ("skickade
  // i dag"). That route costs a second or more — whyNothing alone is
  // most of it — and Auto-ansökan used to call it every 8 s whether or
  // not anything had moved. This hash moves when any of those inputs do.
  // What it cannot see — an ad closing, a deadline passing — the view
  // picks up on its slow fallback refresh.
  let kampanjer = null;
  if (delar.has('kampanjer')) {
    const { rows: [k] } = await pool.query(
      `WITH c AS (
         SELECT s.id, md5((to_jsonb(s) - 'query_embedding')::text) AS rad
         FROM searches s
         WHERE s.profile_id = $1 AND s.deleted_at IS NULL AND s.campaign_created_at IS NOT NULL)
       SELECT md5(concat_ws('|',
         current_date,
         (SELECT string_agg(c.rad, ',' ORDER BY c.id) FROM c),
         (SELECT concat_ws(':', count(*), count(m.score), count(m.score_requested_at),
                           max(m.scored_at), max(ls.scanned_at), count(ls.ad_id))
            FROM match_results m LEFT JOIN lead_scans ls ON ls.ad_id = m.ad_id
           WHERE m.search_id IN (SELECT id FROM c)),
         (SELECT concat_ws(':', count(*), max(a.updated_at)) FROM applications a
           WHERE a.origin_search_id IN (SELECT id FROM c)),
         (SELECT concat_ws(':', count(*), max(created_at)) FROM ad_contacts WHERE profile_id = $1)
       )) AS v`, [profileId]);
    kampanjer = k.v;
  }

  // The address finder (components/LeadFinder.jsx) lists one campaign's
  // ads with what the scan found and what the user typed in.
  let adresser = null;
  if (adresserFör && await ägareAvSökning(adresserFör)) {
    const { rows: [a] } = await pool.query(
      `SELECT md5(concat_ws('|',
         (SELECT concat_ws(':', count(*), count(m.score), max(ls.scanned_at), count(ls.ad_id))
            FROM match_results m LEFT JOIN lead_scans ls ON ls.ad_id = m.ad_id
           WHERE m.search_id = $1),
         (SELECT concat_ws(':', count(*), max(created_at)) FROM ad_contacts WHERE profile_id = $2),
         (SELECT concat_ws(':', count(*), max(updated_at)) FROM applications
           WHERE origin_search_id = $1)
       )) AS v`, [adresserFör, profileId]);
    adresser = a.v;
  }

  // one opaque string — the client only cares whether it changed
  const version = [
    v.msgs, Math.round(Number(v.last_msg) || 0),
    v.suggestions, Math.round(Number(v.last_app) || 0), v.sent_apps,
  ].join(':');

  return NextResponse.json({ version, search, kampanjer, adresser }, {
    headers: { 'cache-control': 'no-store' },
  });
}
