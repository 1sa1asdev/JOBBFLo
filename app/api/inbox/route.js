import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';

export const dynamic = 'force-dynamic';

// thread list: every application that left draft stage
export async function GET() {
  const { rows } = await pool.query(
    `SELECT a.id, a.status, a.sent_at, a.sent_to, a.updated_at,
       a.followup_enabled, a.followup_days, a.followup_sent_at,
       ads.title, ads.employer, ads.deadline, ads.employer_type,
       s.name AS search_name, s.deleted_at AS search_deleted_at, a.origin_search_id,
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
     ORDER BY COALESCE(last_msg.sent_at, a.sent_at) DESC NULLS LAST`
  );
  return NextResponse.json(rows);
}
