import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { hashPassword, signSession, sessionCookieOptions, SESSION_COOKIE } from '../../../../src/auth.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const { name, email, password } = await req.json();
  const mail = email?.trim().toLowerCase();
  if (!mail || !/^\S+@\S+\.\S+$/.test(mail)) {
    return NextResponse.json({ error: 'ogiltig e-postadress' }, { status: 400 });
  }
  if (!password || password.length < 8) {
    return NextResponse.json({ error: 'lösenordet måste vara minst 8 tecken' }, { status: 400 });
  }
  if (!name?.trim()) {
    return NextResponse.json({ error: 'namn krävs' }, { status: 400 });
  }

  const { rows: [existing] } = await pool.query(`SELECT id FROM users WHERE email = $1`, [mail]);
  if (existing) {
    return NextResponse.json({ error: 'kontot finns redan — logga in istället' }, { status: 409 });
  }

  const client = await pool.connect();
  let user;
  try {
    await client.query('BEGIN');
    ({ rows: [user] } = await client.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
      [mail, hashPassword(password)]
    ));

    // claim a seeded/migrated profile with the same email, else start fresh
    const { rows: [claimed] } = await client.query(
      `UPDATE profile SET user_id = $1, updated_at = now()
       WHERE user_id IS NULL AND lower(email) = $2 RETURNING id`,
      [user.id, mail]
    );
    if (!claimed) {
      await client.query(
        `INSERT INTO profile (user_id, name, email) VALUES ($1, $2, $3)`,
        [user.id, name.trim(), mail]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const res = NextResponse.json({ ok: true, email: user.email }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, signSession(user.id), sessionCookieOptions());
  return res;
}
