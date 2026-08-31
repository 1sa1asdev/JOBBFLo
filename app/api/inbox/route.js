import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';

export const dynamic = 'force-dynamic';

// thread list: every application that left draft stage
export async function GET(req) {
  // auto-applied threads live in their own inbox so a campaign's
  // output is never confused with applications you sent yourself
  const source = new URL(req.url).searchParams.get('source');   // 'auto' | 'user' | null
  const { rows } = await pool.query(
    `SELECT a.id, a.status, a.sent_at, a.sent_to, a.updated_at,
       a.followup_enabled, a.followup_days, a.followup_sent_at, a.sent_by,
       ads.title, ads.employer, ads.deadline, ads.employer_type,
       s.name AS search_name, s.deleted_at AS search_deleted_at, a.origin_search_id,
       -- The campaign a thread belongs to, carried on every row so the
       -- auto-inbox can group by it. A campaign's PURPOSE is its
       -- criteria_text — the same sentence that decides which ads it
       -- hunts — so showing it here is showing why this letter was sent.
       s.criteria_text          AS campaign_purpose,
       s.auto_apply_enabled     AS campaign_enabled,
       s.auto_apply_paused_reason AS campaign_paused,
       last_msg.from_name AS last_from_name, last_msg.from_addr AS last_from_addr,
       last_msg.sent_at AS last_msg_at, last_msg.direction AS last_direction,
       left(last_msg.body_text, 120) AS last_preview,
       (SELECT count(*) FROM suggested_replies sr
        WHERE sr.application_id = a.id AND NOT sr.dismissed) AS pending_suggestions
     FROM applications a
     JOIN ads ON ads.id = a.ad_id
     LEFT JOIN searches s ON s.id = a.origin_search_id
     LEFT JOIN LATERAL (
       SELECT * FROM email_messages em WHERE em.application_id = a.id
       ORDER BY em.sent_at DESC LIMIT 1
     ) last_msg ON true
     WHERE a.status <> 'drafted'
       -- Applications the user made through the ad's link sit with the
       -- ones sent by hand: both are "you applied to this", and keeping
       -- them out of the inbox was the whole problem. Only campaign
       -- output stays separate.
       AND ($1::text IS NULL OR
            ($1 = 'auto' AND a.sent_by = 'auto') OR
            ($1 = 'user' AND a.sent_by IN ('user', 'external')))
     ORDER BY COALESCE(last_msg.sent_at, a.sent_at) DESC NULLS LAST`,
    [source === 'auto' || source === 'user' ? source : null]
  );
  return NextResponse.json(rows);
}
