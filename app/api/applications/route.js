import { NextResponse } from 'next/server';
import { draftLetter } from '../../../src/letters.js';

export const dynamic = 'force-dynamic';

// create (or return) the draft for an ad — UNIQUE(ad_id) makes
// a second application for the same ad physically impossible
export async function POST(req) {
  const { adId, searchId } = await req.json();
  if (!adId) return NextResponse.json({ error: 'adId krävs' }, { status: 400 });
  try {
    const app = await draftLetter(adId, { originSearchId: searchId || null });
    return NextResponse.json(app, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
