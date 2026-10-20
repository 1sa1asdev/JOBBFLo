import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { verifyPassword, signSession, sessionCookieOptions, SESSION_COOKIE } from '../../../../src/auth.js';
import { inloggningsläge } from '../../../../src/authMode.js';
import { inomTakt, klientAdress, förMånga } from '../../../../src/takt.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  // Password accounts exist only in the local password mode (CI and
  // testing). In the hosted app, Google is the only way in — a working
  // signup route here would be a way around it.
  if (inloggningsläge() !== 'lösenord') {
    return NextResponse.json({ error: 'finns inte' }, { status: 404 });
  }
  // Guessing passwords from one address stops here.
  if (!(await inomTakt('inloggning', await klientAdress()))) return förMånga();
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
