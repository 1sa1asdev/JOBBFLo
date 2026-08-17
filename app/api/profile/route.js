import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Explicit columns, never SELECT *: the table holds the CV as bytea
  // and the encrypted provider keys. `SELECT *` serialised the whole
  // PDF into JSON — a 247 kB response for a form that needs none of
  // it — and shipped the key ciphertext to the browser for no reason.
  const { rows: [profile] } = await pool.query(
    `SELECT id, name, email, phone, city,
            cv_filename, cv_text, cv_uploaded_at,
            cv_profile, cv_profile_at, cv_profile_model,
            about_text, tone_text, created_at, updated_at,
            (cv_file IS NOT NULL) AS cv_attachable,
            octet_length(cv_file) AS cv_bytes
     FROM profile LIMIT 1`
  );
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
