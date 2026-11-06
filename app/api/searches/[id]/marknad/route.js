import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { ägareAvSökning, inteHittad } from '../../../../../src/auth.js';
import { sökläge } from '../../../../../src/yrkesbarometer.js';

export const dynamic = 'force-dynamic';

// The search chat's market card: Arbetsförmedlingen's assessment of the
// occupations this search finds (src/yrkesbarometer.js sökläge). Built
// from data, not by a model — free to show, and nothing to invent.
export async function GET(req, { params }) {
  const { id } = await params;
  const profileId = await ägareAvSökning(id);
  if (!profileId) return inteHittad('sökningen finns inte');
  try {
    return NextResponse.json({ läge: await sökläge(id) });
  } catch (err) {
    unstable_rethrow(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
