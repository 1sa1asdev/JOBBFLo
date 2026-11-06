import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { aktivProfilId, ägareAvSökning, ägareAvAnnons, inteHittad } from '../../../src/auth.js';
import { draftLetter, ownLetter } from '../../../src/letters.js';

export const dynamic = 'force-dynamic';

// create (or return) the draft for an ad — UNIQUE(ad_id) makes
// a second application for the same ad physically impossible.
// With `egen` the draft is the user's own text, no model involved.
export async function POST(req) {
  const { adId, searchId, egen } = await req.json();
  if (!adId) return NextResponse.json({ error: 'adId krävs' }, { status: 400 });
  // The search decides which CV the letter is written from (its tailored
  // one, if it has one). Someone else's search would mean a letter built
  // on someone else's CV.
  if (searchId && !(await ägareAvSökning(searchId))) return inteHittad('sökningen finns inte');
  try {
    if (egen) {
      // a pasted ad is its maker's alone; the shared pool is everyone's
      if (!(await ägareAvAnnons(adId))) return inteHittad('annonsen finns inte');
      const app = await ownLetter(adId, {
        originSearchId: searchId || null, profileId: await aktivProfilId(),
        subject: egen.subject, body: egen.body,
      });
      return NextResponse.json(app, { status: 201 });
    }
    const app = await draftLetter(adId,
      { originSearchId: searchId || null, profileId: await aktivProfilId() });
    return NextResponse.json(app, { status: 201 });
  } catch (err) {
    unstable_rethrow(err); // a 401/403 from the auth check is not this route's error
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
