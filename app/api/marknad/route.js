import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { aktivProfilId } from '../../../src/auth.js';
import { marknadsläge } from '../../../src/marknad.js';

export const dynamic = 'force-dynamic';

// The Marknaden tab: the shared market, the same for every signed-in
// user. Counts only (src/marknad.js); nothing in it is the caller's.
export async function GET(req) {
  await aktivProfilId(); // signed in, like every other page of the app
  const region = new URL(req.url).searchParams.get('region') || null;
  try {
    return NextResponse.json(await marknadsläge({ regionId: region }), {
      // the pool moves by the minute, the picture by the day
      headers: { 'cache-control': 'private, max-age=300' },
    });
  } catch (err) {
    unstable_rethrow(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
