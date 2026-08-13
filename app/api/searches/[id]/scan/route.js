import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';
import { backfillSearch } from '../../../../../src/fetchJobs.js';
import { scoreSearch } from '../../../../../src/score.js';

export const dynamic = 'force-dynamic';

// manual "skanna nu"
export async function POST(_req, { params }) {
  const { id } = await params;
  const { rows: [search] } = await pool.query(
    `SELECT * FROM searches WHERE id = $1 AND deleted_at IS NULL`, [id]
  );
  if (!search) return NextResponse.json({ error: 'not found' }, { status: 404 });

  try {
    await backfillSearch(search.api_filters || {}, 50);
    const results = await scoreSearch(id, { limit: 20 });
    return NextResponse.json({ scored: results.length });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
