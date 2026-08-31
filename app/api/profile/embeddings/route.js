import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { embeddingCoverage } from '../../../../src/refresh.js';

export const dynamic = 'force-dynamic';

// What one ad costs to embed, measured on the current provider
// (OpenAI text-embedding-3-small via OpenRouter, 768 dims). Kept here
// beside the switch so the number the user is shown is the number the
// estimate is built from, rather than a figure written into copy once
// and never revisited.
const COST_PER_AD = 0.0000125;

function state(row, cov) {
  const remaining = Math.max(0, cov.total - cov.embedded);
  return {
    enabled: row.embeddings_enabled,
    total: cov.total,
    embedded: cov.embedded,
    remaining,
    pct: cov.pct,
    // Rounded up to the öre it would actually appear as, and never
    // reported as 0 when there is real work left — "free" would be a
    // lie the moment the switch is flipped.
    estimatedUsd: Math.ceil(remaining * COST_PER_AD * 100) / 100,
  };
}

export async function GET() {
  const { rows: [row] } = await pool.query(
    `SELECT embeddings_enabled FROM profile LIMIT 1`);
  if (!row) return NextResponse.json({ error: 'ingen profil' }, { status: 400 });
  return NextResponse.json(state(row, await embeddingCoverage()));
}

export async function PATCH(req) {
  const { enabled } = await req.json();
  const { rows: [row] } = await pool.query(
    `UPDATE profile SET embeddings_enabled = $1 RETURNING embeddings_enabled`,
    [Boolean(enabled)]
  );
  if (!row) return NextResponse.json({ error: 'ingen profil' }, { status: 400 });
  return NextResponse.json(state(row, await embeddingCoverage()));
}
