import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { rows: [profile] } = await pool.query(`SELECT * FROM profile LIMIT 1`);
  if (!profile) return NextResponse.json({ error: 'ingen profil — kör db:seed' }, { status: 404 });
  const { rows: projects } = await pool.query(
    `SELECT * FROM projects WHERE profile_id = $1 ORDER BY name`, [profile.id]
  );
  return NextResponse.json({ ...profile, projects });
}

export async function PUT(req) {
  const body = await req.json();
  const fields = ['name', 'email', 'phone', 'city', 'cv_text', 'about_text', 'tone_text'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (f in body) { vals.push(body[f]); sets.push(`${f} = $${vals.length}`); }
  }
  if (!sets.length) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });

  const { rows: [profile] } = await pool.query(
    `UPDATE profile SET ${sets.join(', ')}, updated_at = now() RETURNING *`, vals
  );
  return NextResponse.json(profile);
}
