import { NextResponse } from 'next/server';
import { scanSearch } from '../../../../../src/score.js';

export const dynamic = 'force-dynamic';

// manual "skanna nu" — layer 1 then layer 2, chained
export async function POST(_req, { params }) {
  const { id } = await params;
  try {
    const results = await scanSearch(id, { limit: 20 });
    return NextResponse.json({ scored: results.length });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
