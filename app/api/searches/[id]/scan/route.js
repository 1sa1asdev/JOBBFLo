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
    const queue = await scanSearch(id, { limit: 20, background: true });
    return NextResponse.json(queue);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
