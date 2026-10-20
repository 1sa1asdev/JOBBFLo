import { NextResponse } from 'next/server';
import { currentProfile } from '../../../../src/auth.js';
import { inloggningsläge } from '../../../../src/authMode.js';

export const dynamic = 'force-dynamic';

// Who is signed in, and how — the account section shows "Logga ut" only
// when there is something to sign out of.
export async function GET() {
  const inloggning = inloggningsläge();
  if (inloggning === 'av') return NextResponse.json({ inloggning });
  try {
    const profile = await currentProfile();
    return NextResponse.json({ inloggning, name: profile.name, email: profile.account_email });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
