import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { restoreVersion, reuseWarnings } from '../../../../src/letters.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const { rows: [app] } = await pool.query(
    `SELECT a.*, ads.title, ads.employer, ads.municipality, ads.deadline, ads.description,
       ads.apply_email, ads.apply_url, ads.ats_vendor
     FROM applications a JOIN ads ON ads.id = a.ad_id WHERE a.id = $1`, [id]
  );
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { rows: versions } = await pool.query(
    `SELECT version, change_note, created_at FROM letter_versions
     WHERE application_id = $1 ORDER BY version DESC`, [id]
  );
  const warnings = await reuseWarnings(id);

  return NextResponse.json({ ...app, versions, reuse_warnings: warnings });
}

export async function PATCH(req, { params }) {
  const { id } = await params;
  const body = await req.json();

  if ('restore_version' in body) {
    const app = await restoreVersion(id, body.restore_version);
    return NextResponse.json(app);
  }

  const sets = [];
  const vals = [id];
  if ('followup_enabled' in body) { vals.push(body.followup_enabled); sets.push(`followup_enabled = $${vals.length}`); }
  if ('followup_days' in body) { vals.push(body.followup_days); sets.push(`followup_days = $${vals.length}`); }
  if ('status' in body && ['ghosted', 'withdrawn'].includes(body.status)) {
    vals.push(body.status); sets.push(`status = $${vals.length}`);
  }
  // manual text edits to a draft
  if ('letter_text' in body) { vals.push(body.letter_text); sets.push(`letter_text = $${vals.length}`); }
  if ('subject' in body) { vals.push(body.subject); sets.push(`subject = $${vals.length}`); }
  if (!sets.length) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });

  const { rows: [app] } = await pool.query(
    `UPDATE applications SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals
  );
  return NextResponse.json(app);
}
