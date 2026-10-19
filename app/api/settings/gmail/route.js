import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { aktivProfilId } from '../../../../src/auth.js';
import { encryptSecret } from '../../../../src/secrets.js';
import { testaGmail, städaLösenord } from '../../../../src/credentials.js';

export const dynamic = 'force-dynamic';
// Two logins against Google, each with its own timeout.
export const maxDuration = 60;

// ------------------------------------------------------------
// The user's Gmail connection: the account they send from and read
// replies in. The address is the profile's own (the sender is always
// the user); this only manages the app password.
//
// The password goes in and never comes back out — not even masked. The
// only thing the browser ever learns is whether it works.
// ------------------------------------------------------------

async function status(profileId) {
  const { rows: [p] } = await pool.query(
    `SELECT email, gmail_app_password_enc IS NOT NULL AS sparat, gmail_verified_at
     FROM profile WHERE id = $1`, [profileId]);
  return {
    address: p?.email || null,
    connected: Boolean(p?.sparat),
    verified_at: p?.gmail_verified_at || null,
  };
}

export async function GET() {
  return NextResponse.json(await status(await aktivProfilId()));
}

// Test, then save — and only save what passed. A stored password that
// does not work is worse than none: the campaign would discover it the
// next morning, one failed letter at a time.
export async function PUT(req) {
  const profileId = await aktivProfilId();
  const { password } = await req.json().catch(() => ({}));
  const pass = städaLösenord(password);
  if (!pass) return NextResponse.json({ error: 'Klistra in applösenordet.' }, { status: 400 });

  const { address } = await status(profileId);
  if (!address) {
    return NextResponse.json({ error: 'Profilen saknar mejladress.' }, { status: 400 });
  }

  const test = await testaGmail({ user: address, pass });
  if (!test.ok) {
    return NextResponse.json({ error: test.fel, smtp: test.smtp, imap: test.imap }, { status: 422 });
  }

  await pool.query(
    `UPDATE profile SET gmail_app_password_enc = $2, gmail_verified_at = now(), updated_at = now()
     WHERE id = $1`, [profileId, encryptSecret(pass)]);
  return NextResponse.json({ ...(await status(profileId)), smtp: test.smtp, imap: test.imap });
}

export async function DELETE() {
  const profileId = await aktivProfilId();
  await pool.query(
    `UPDATE profile SET gmail_app_password_enc = NULL, gmail_verified_at = NULL, updated_at = now()
     WHERE id = $1`, [profileId]);
  return NextResponse.json(await status(profileId));
}
