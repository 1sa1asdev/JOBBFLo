import { NextResponse } from 'next/server';
import { aktivProfilId, ägareAvSökning, inteHittad } from '../../../../src/auth.js';
import { refreshCvProfile } from '../../../../src/cvprofile.js';

export const dynamic = 'force-dynamic';

// Rebuild the CV reading on demand — after editing the CV text, or
// after switching to a better model. One call, awaited, because the
// user is looking at the panel waiting for the result.
export async function POST(req) {
  try {
    const { searchId = null } = await req.json().catch(() => ({}));
    if (searchId && !(await ägareAvSökning(searchId))) return inteHittad('sökningen finns inte');
    const profile = await refreshCvProfile({ searchId, profileId: await aktivProfilId() });
    if (!profile) {
      return NextResponse.json({ error: 'inget CV att läsa' }, { status: 400 });
    }
    return NextResponse.json(profile);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
