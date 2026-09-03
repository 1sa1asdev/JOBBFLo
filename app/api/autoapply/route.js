import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';
import { candidatesFor, runAutoApply } from '../../../src/autoapply.js';

export const dynamic = 'force-dynamic';

// campaign overview: every search, its rule, and what would go out next
export async function GET() {
  const { rows: searches } = await pool.query(
    `SELECT s.id, s.name, s.auto_apply_enabled, s.auto_apply_min_score,
            s.auto_apply_daily_limit, s.auto_apply_paused_reason,
            s.auto_apply_require_score, s.campaign_created_at,
            s.location, s.must_criteria, s.location_ratio,
            s.fetch_offset, s.fetch_total, s.fetch_done_at, s.scan_enabled,
            s.criteria_text, s.campaign_letter_approved_at,
            (s.campaign_letter IS NOT NULL) AS has_letter,
            (SELECT count(*)::int FROM applications a
             WHERE a.origin_search_id = s.id AND a.sent_by = 'auto') AS sent_total,
            (SELECT count(*)::int FROM applications a
             WHERE a.origin_search_id = s.id AND a.sent_by = 'auto'
               AND a.sent_at > date_trunc('day', now())) AS sent_today
     FROM searches s
     WHERE s.deleted_at IS NULL
       -- Only actual campaigns. Listing every saved search here is what
       -- made the ✕ look broken: it cleared campaign fields that were
       -- already empty, and the card never went anywhere.
       AND s.campaign_created_at IS NOT NULL
     ORDER BY s.campaign_created_at`
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
  const { searchId, enabled, min_score, daily_limit, clear_campaign, name, criteria,
          require_score, must_criteria, location_ratio } = await req.json();
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
  // Whether this campaign is allowed to apply to ads no model has read.
  if (require_score !== undefined) {
    vals.push(Boolean(require_score));
    sets.push(`auto_apply_require_score = $${vals.length}`);
  }
  if (daily_limit !== undefined) {
    vals.push(Math.max(1, Math.min(100, Number(daily_limit))));
    sets.push(`auto_apply_daily_limit = $${vals.length}`);
  }
  // How the daily letters are split between the campaign's places.
  // Null clears it — back to pure score order.
  if (location_ratio !== undefined) {
    const r = location_ratio && Object.keys(location_ratio).length
      ? Object.fromEntries(Object.entries(location_ratio)
          .map(([k, v]) => [k, Math.max(0, Math.min(100, Number(v) || 0))])
          .filter(([, v]) => v > 0))
      : null;
    vals.push(r && Object.keys(r).length ? JSON.stringify(r) : null);
    sets.push(`location_ratio = $${vals.length}::jsonb`);
  }

  // A free-text rule the model enforces while scoring. Empty string
  // clears it — an empty rule is no rule, not a rule matching nothing.
  if (must_criteria !== undefined) {
    const t = String(must_criteria || '').trim();
    vals.push(t ? t.slice(0, 600) : null);
    sets.push(`must_criteria = $${vals.length}`);
  }

  // A campaign's NAME is how its replies are grouped in the inbox, so
  // renaming it has to be possible without rebuilding the campaign.
  if (name !== undefined) {
    const n = String(name || '').trim();
    if (!n) return NextResponse.json({ error: 'namnet får inte vara tomt' }, { status: 400 });
    vals.push(n.slice(0, 120)); sets.push(`name = $${vals.length}`);
  }

  // The campaign's PURPOSE — what it is hunting for. Editing it re-runs
  // layer 1, because the criteria are what produce the API filters, and
  // stale filters would keep finding the old kind of ad.
  //
  // It must NOT wipe the pool the way chat.js used to: candidates found
  // under the old criteria go, but a favourite or a paid verdict is a
  // human decision and survives. Same rule, same reason.
  let criteriaChanged = false;
  let parseError = null;
  if (criteria !== undefined) {
    const text = String(criteria || '').trim();
    if (!text) return NextResponse.json({ error: 'syftet får inte vara tomt' }, { status: 400 });
    vals.push(text); sets.push(`criteria_text = $${vals.length}`);
    sets.push(`criteria_changed_at = now()`, `fetch_offset = 0`,
              `fetch_total = NULL`, `fetch_done_at = NULL`, `dropped_filters = NULL`);

    try {
      const { parseCriteria } = await import('../../../src/score.js');
      const { filters } = await parseCriteria(text);
      vals.push(JSON.stringify(filters || {}));
      sets.push(`api_filters = $${vals.length}`);
      criteriaChanged = true;
    } catch (err) {
      // No key, model down, out of credit. Do NOT substitute a crude
      // free-text filter here: the existing api_filters are the result
      // of a successful parse, and replacing working taxonomy filters
      // with `{q: ...}` would quietly widen the campaign to everything.
      // Keep the new purpose text, keep the old filters, and say so —
      // a stale filter the user knows about beats a silent downgrade.
      console.error('kampanjsyfte: kunde inte tolka kriterier —', err.message);
      parseError = 'Syftet sparades, men kunde inte översättas till filter just nu — '
        + 'kampanjen söker vidare med de gamla filtren. Spara igen när modellen svarar.';
    }
  }

  // remove the campaign without touching the search it rides on
  if (clear_campaign) {
    sets.push(`campaign_letter = NULL`, `campaign_subject = NULL`,
              `campaign_letter_approved_at = NULL`, `auto_apply_paused_reason = NULL`,
              // This is what makes the removal visible. Without it the
              // card came back on the next load, because being listed
              // had nothing to do with the fields being cleared.
              `campaign_created_at = NULL`);
  }
  if (!sets.length) return NextResponse.json({ error: 'inget att ändra' }, { status: 400 });

  const { rows: [s] } = await pool.query(
    `UPDATE searches SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`, vals
  );

  // A soft-deleted search matches nothing, and returning the resulting
  // `undefined` made this route answer every such call with an empty
  // 500 — no status, no message, nothing to act on. The inbox links
  // back to deleted searches by design (origin_search_id survives the
  // delete), so this is a normal request, not an exceptional one.
  if (!s) {
    return NextResponse.json(
      { error: 'Sökningen finns inte längre — kampanjen kan inte ändras.' },
      { status: 404 }
    );
  }

  if (criteriaChanged) {
    const { rowCount: dropped } = await pool.query(
      `DELETE FROM match_results
       WHERE search_id = $1 AND shortlisted_at IS NULL AND score IS NULL`, [searchId]
    );
    console.log(`kampanjsyfte ändrat: ${dropped} kandidater rensade, favoriter och bedömningar behållna`);
    // free: one API call per page, no model
    const { scanSearch } = await import('../../../src/score.js');
    scanSearch(searchId, { pages: 2 }).catch((e) => console.error(`kampanj-scan ${searchId}:`, e.message));
  }

  return NextResponse.json(parseError ? { ...s, warning: parseError } : s);
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
