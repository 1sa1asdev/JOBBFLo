import { NextResponse } from 'next/server';
import { currentUserId, aktivProfilId } from '../../../src/auth.js';
import { pool } from '../../../src/db.js';
import { raderaKonto } from '../../../src/konto.js';
import { SESSION_COOKIE } from '../../../src/auth.js';

export const dynamic = 'force-dynamic';

// Erase the account and everything in it (src/konto.js). The user types
// their own address to confirm — a stray click must not be able to.
export async function DELETE(req) {
  await aktivProfilId(); // 401/403 as for any other route
  const userId = await currentUserId();
  if (!userId) {
    return NextResponse.json({ error: 'det finns inget konto att radera utan inloggning' }, { status: 400 });
  }
  const { bekräfta } = await req.json().catch(() => ({}));
  const { rows: [u] } = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
  if (!u || String(bekräfta || '').trim().toLowerCase() !== u.email.toLowerCase()) {
    return NextResponse.json({ error: 'skriv kontots e-postadress för att bekräfta' }, { status: 400 });
  }
  const svar = await raderaKonto(userId);
  const res = NextResponse.json(svar);
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
