import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';

export const dynamic = 'force-dynamic';

// dismiss ("Släng") a suggested reply
export async function PATCH(_req, { params }) {
  const { id } = await params;
  await pool.query(`UPDATE suggested_replies SET dismissed = true WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
