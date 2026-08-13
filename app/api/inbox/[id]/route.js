import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const { rows: [app] } = await pool.query(
    `SELECT a.*, ads.title, ads.employer, ads.deadline, ads.municipality,
       s.name AS search_name, s.deleted_at AS search_deleted_at
     FROM applications a
     JOIN ads ON ads.id = a.ad_id
     LEFT JOIN searches s ON s.id = a.origin_search_id
     WHERE a.id = $1`, [id]
  );
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { rows: messages } = await pool.query(
    `SELECT * FROM email_messages WHERE application_id = $1 ORDER BY sent_at`, [id]
  );
  const { rows: suggestions } = await pool.query(
    `SELECT * FROM suggested_replies WHERE application_id = $1 AND NOT dismissed
     ORDER BY created_at DESC`, [id]
  );
  const { rows: [prep] } = await pool.query(
    `SELECT * FROM interview_prep WHERE application_id = $1`, [id]
  );

  return NextResponse.json({ ...app, messages, suggestions, prep: prep || null });
}
