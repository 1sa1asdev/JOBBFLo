import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '../../../../src/auth.js';
import { inloggningsläge } from '../../../../src/authMode.js';
import { supabaseServer } from '../../../../src/supabase.js';

export const dynamic = 'force-dynamic';

// Signs out of whichever kind of session the request carries. Supabase
// revokes the refresh token and clears its own cookies through the
// server client; the local cookie is cleared either way.
export async function POST() {
  if (inloggningsläge() === 'supabase') {
    await (await supabaseServer()).auth.signOut().catch(() => {});
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
