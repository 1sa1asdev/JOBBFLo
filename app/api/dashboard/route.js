import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// What the app has actually done, and which search did it.
//
// Every other view answers "what is happening now". This one answers
// "was any of it worth it" — and that question only means something
// broken down by SOURCE. 238 letters from one campaign with 89 replies
// and 2 interviews is a different fact from 238 letters spread over
// four searches, and the app could not tell the difference.
//
// Outcome, not activity. Ads found and pages scanned are effort;
// replies and interviews are results. Effort is here only where it
// explains a result — a campaign that cannot reach its ads has an
// obvious reason for a low count.
//
// Rates are suppressed under a floor rather than shown as noise, the
// way calibration() already does. One reply out of two is not "50%".
// ------------------------------------------------------------
const MIN_FOR_RATE = 10;

export async function GET(req) {
  const dagar = Math.min(Number(new URL(req.url).searchParams.get('dagar')) || 0, 365);
  // 0 = all time. Written as a nullable interval so one query serves
  // both rather than two that can drift apart.
  // Not named `window` — it shadows a global that exists in the
  // client bundle even though this file only runs on the server.
  const period = dagar ? `${dagar} days` : null;

  const { rows: [total] } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status <> 'drafted') AS skickade,
       count(*) FILTER (WHERE status = 'drafted') AS utkast,
       count(*) FILTER (WHERE status IN ('replied','interview','rejected')) AS svar,
       count(*) FILTER (WHERE status = 'interview') AS intervjuer,
       count(*) FILTER (WHERE status = 'rejected') AS avslag,
       count(*) FILTER (WHERE status = 'ghosted') AS ghostade,
       count(*) FILTER (WHERE status = 'sent') AS vantar,
       min(sent_at) AS forsta,
       max(sent_at) AS senaste
     FROM applications
     WHERE ($1::interval IS NULL OR sent_at > now() - $1::interval)`,
    [period]
  );

  // Per source. origin_search_id survives a deleted search as NULL
  // (ON DELETE SET NULL), and campaign_name was stamped at send time
  // precisely so that history does not evaporate with the rule that
  // produced it — so a deleted campaign still reports its results.
  const { rows: sources } = await pool.query(
    `SELECT
       COALESCE(s.name, a.campaign_name, 'Utan sökning') AS namn,
       s.id AS search_id,
       (s.id IS NOT NULL AND s.campaign_created_at IS NOT NULL) AS ar_kampanj,
       (s.deleted_at IS NOT NULL) AS borttagen,
       bool_or(a.sent_by = 'auto') AS automatisk,
       count(*) AS skickade,
       count(*) FILTER (WHERE a.status IN ('replied','interview','rejected')) AS svar,
       count(*) FILTER (WHERE a.status = 'interview') AS intervjuer,
       count(*) FILTER (WHERE a.status = 'rejected') AS avslag,
       count(*) FILTER (WHERE a.status = 'sent') AS vantar,
       min(a.sent_at) AS forsta,
       max(a.sent_at) AS senaste
     FROM applications a
     LEFT JOIN searches s ON s.id = a.origin_search_id
     WHERE a.status <> 'drafted'
       AND ($1::interval IS NULL OR a.sent_at > now() - $1::interval)
     GROUP BY 1, 2, 3, 4
     ORDER BY count(*) DESC`,
    [period]
  );

  // Letters per day, for the shape of the effort over time. Generated
  // from a date series so a day with nothing sent is a zero rather than
  // a gap the chart closes up.
  const { rows: perDay } = await pool.query(
    `SELECT d::date AS dag,
       count(a.id) AS skickade,
       count(a.id) FILTER (WHERE a.status IN ('replied','interview','rejected')) AS svar
     FROM generate_series(
            COALESCE((SELECT min(sent_at)::date FROM applications), current_date),
            current_date, '1 day') d
     LEFT JOIN applications a
       ON a.sent_at::date = d::date AND a.status <> 'drafted'
     GROUP BY 1 ORDER BY 1`
  );

  // The funnel, per campaign: why a campaign that found 1200 ads sent
  // 238 letters. Each step is where candidates are actually lost, which
  // is the only useful answer to "why so few".
  const { rows: funnel } = await pool.query(
    `SELECT s.name,
       count(*) AS hittade,
       count(*) FILTER (WHERE ads.apply_email IS NOT NULL) AS med_adress,
       count(*) FILTER (WHERE m.score IS NOT NULL) AS bedomda,
       count(*) FILTER (WHERE app.id IS NOT NULL) AS ansokta
     FROM searches s
     JOIN match_results m ON m.search_id = s.id
     JOIN ads ON ads.id = m.ad_id
     LEFT JOIN applications app ON app.ad_id = ads.id
     WHERE s.deleted_at IS NULL AND s.campaign_created_at IS NOT NULL
     GROUP BY s.name ORDER BY count(*) DESC`
  );

  // What it cost. Present only if anything has been recorded — an empty
  // spend table means the switch is off, not that the work was free.
  const { rows: [cost] } = await pool.query(
    `SELECT round(sum(cost_usd)::numeric, 2) AS usd, count(*) AS anrop
     FROM llm_usage
     WHERE created_at > date_trunc('month', now())`
  ).catch(() => ({ rows: [null] }));

  const rate = (del, av) => (Number(av) >= MIN_FOR_RATE
    ? Math.round((Number(del) / Number(av)) * 100) : null);

  return NextResponse.json({
    total: {
      ...total,
      replyRate: rate(total.svar, total.skickade),
      interviewRate: rate(total.intervjuer, total.skickade),
    },
    sources: sources.map((k) => ({
      ...k,
      replyRate: rate(k.svar, k.skickade),
      interviewRate: rate(k.intervjuer, k.skickade),
    })),
    perDay,
    funnel,
    cost: cost?.usd ? cost : null,
    minForRate: MIN_FOR_RATE,
  });
}
