import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { currentProfile, adminProfilId } from '../../../../src/auth.js';
import { inloggningsläge } from '../../../../src/authMode.js';

export const dynamic = 'force-dynamic';

// Who is signed in, and how — the account section shows "Logga ut" only
// when there is something to sign out of, and the admin link only to
// the operator.
export async function GET() {
  const inloggning = inloggningsläge();
  if (inloggning === 'av') return NextResponse.json({ inloggning, admin: Boolean(await adminProfilId()) });
  try {
    const profile = await currentProfile();
    return NextResponse.json({
      inloggning, name: profile.name, email: profile.account_email,
      admin: Boolean(await adminProfilId()),
    });
  } catch (err) {
    unstable_rethrow(err); // a 401/403 from the auth check is not this route's error
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
