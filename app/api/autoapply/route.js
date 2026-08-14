import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';
import { candidatesFor, runAutoApply } from '../../../src/autoapply.js';

export const dynamic = 'force-dynamic';

// campaign overview: every search, its rule, and what would go out next
export async function GET() {
  const { rows: searches } = await pool.query(
    `SELECT s.id, s.name, s.auto_apply_enabled, s.auto_apply_min_score,
            s.auto_apply_daily_limit, s.auto_apply_paused_reason,
            s.criteria_text, s.campaign_letter_approved_at,
            (s.campaign_letter IS NOT NULL) AS has_letter,
            (SELECT count(*)::int FROM applications a
             WHERE a.origin_search_id = s.id AND a.sent_by = 'auto') AS sent_total,
            (SELECT count(*)::int FROM applications a
             WHERE a.origin_search_id = s.id AND a.sent_by = 'auto'
               AND a.sent_at > date_trunc('day', now())) AS sent_today
     FROM searches s WHERE s.deleted_at IS NULL ORDER BY s.created_at`
  );

  // what each campaign would send right now — the user should be able
  // to see the queue before switching anything on
  for (const s of searches) {
    s.candidates = await candidatesFor(s.id, { limit: 5 });
  }

  const { rows: log } = await pool.query(
    `SELECT l.*, ads.title, ads.employer, s.name AS search_name
     FROM auto_apply_log l
     LEFT JOIN ads ON ads.id = l.ad_id
     LEFT JOIN searches s ON s.id = l.search_id
     ORDER BY l.created_at DESC LIMIT 40`
  );

  const { rows: [cv] } = await pool.query(
    `SELECT octet_length(cv_file) AS bytes, cv_filename FROM profile LIMIT 1`
  );

  return NextResponse.json({
    searches,
    log,
    cv: cv?.bytes ? { filename: cv.cv_filename, bytes: Number(cv.bytes) } : null,
  });
}

// change a campaign's rule
export async function PATCH(req) {
  const { searchId, enabled, min_score, daily_limit, clear_campaign } = await req.json();
  if (!searchId) return NextResponse.json({ error: 'searchId krävs' }, { status: 400 });

  const sets = [];
  const vals = [searchId];
  if (enabled !== undefined) {
    vals.push(Boolean(enabled)); sets.push(`auto_apply_enabled = $${vals.length}`);
    // turning it back on clears whatever paused it
    if (enabled) sets.push(`auto_apply_paused_reason = NULL`);
  }
  if (min_score !== undefined) {
    vals.push(Math.max(0, Math.min(100, Number(min_score))));
    sets.push(`auto_apply_min_score = $${vals.length}`);
  }
  if (daily_limit !== undefined) {
    vals.push(Math.max(1, Math.min(20, Number(daily_limit))));
    sets.push(`auto_apply_daily_limit = $${vals.length}`);
  }
  // remove the campaign without touching the search it rides on
  if (clear_campaign) {
    sets.push(`campaign_letter = NULL`, `campaign_subject = NULL`,
              `campaign_letter_approved_at = NULL`, `auto_apply_paused_reason = NULL`);
  }
  if (!sets.length) return NextResponse.json({ error: 'inget att ändra' }, { status: 400 });

  const { rows: [s] } = await pool.query(
    `UPDATE searches SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`, vals
  );
  return NextResponse.json(s);
}

// dry run: show exactly what a campaign would send, without sending
export async function POST(req) {
  const { searchId, dryRun = true } = await req.json();
  if (!searchId) return NextResponse.json({ error: 'searchId krävs' }, { status: 400 });
  try {
    const result = await runAutoApply(searchId, { dryRun: Boolean(dryRun) });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
