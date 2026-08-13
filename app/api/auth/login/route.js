import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { verifyPassword, signSession, sessionCookieOptions, SESSION_COOKIE } from '../../../../src/auth.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const { email, password } = await req.json();
  const mail = email?.trim().toLowerCase();

  const { rows: [user] } = await pool.query(
    `SELECT id, email, password_hash FROM users WHERE email = $1`, [mail]
  );
  // same error either way — don't leak which emails have accounts
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return NextResponse.json({ error: 'fel e-post eller lösenord' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, email: user.email });
  res.cookies.set(SESSION_COOKIE, signSession(user.id), sessionCookieOptions());
  return res;
}
