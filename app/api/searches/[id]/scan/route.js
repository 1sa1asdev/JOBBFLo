import { NextResponse } from 'next/server';
import { scanSearch } from '../../../../../src/score.js';

export const dynamic = 'force-dynamic';

// Manual "skanna nu" — layer 1 then layer 2, chained.
// Returns once the ads are queued (about a second), while the
// scoring drains behind the response. The client polls results
// and watches the pending cards resolve.
export async function POST(_req, { params }) {
  const { id } = await params;
  try {
    // find-only: pages through JobSearch and stores candidates. No
    // model is called, so this is safe to run as often as you like.
    const queue = await scanSearch(id, { pages: 3 });
    return NextResponse.json(queue);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
