import { NextResponse } from 'next/server';
import { ägareAvFörslag, inteHittad } from '../../../../src/auth.js';
import { pool } from '../../../../src/db.js';

export const dynamic = 'force-dynamic';

// dismiss ("Släng") a suggested reply
export async function PATCH(_req, { params }) {
  const { id } = await params;
  const profileId = await ägareAvFörslag(id);
  if (!profileId) return inteHittad('förslaget finns inte');
  await pool.query(`UPDATE suggested_replies SET dismissed = true WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
