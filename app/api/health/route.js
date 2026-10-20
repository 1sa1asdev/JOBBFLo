import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// For an uptime monitor: is the database reachable, and has the worker
// checked in lately. Public on purpose (middleware.js) and therefore
// says nothing else — no counts, no users, no versions.
//
// 503 when the database does not answer; the worker's silence is
// reported but does not fail the check, because the UI still works
// without it and the monitor should page about the worker separately.
// ------------------------------------------------------------
export async function GET() {
  const start = Date.now();
  try {
    const { rows: [w] } = await pool.query(
      `SELECT extract(epoch FROM now() - last_run_at)::int AS sekunder
       FROM poll_state WHERE key = 'imap_worker_alive'`);
    const workerSekunder = w?.sekunder ?? null;
    return NextResponse.json({
      ok: true,
      databas_ms: Date.now() - start,
      worker: workerSekunder != null && workerSekunder < 120 ? 'lever' : 'tyst',
    }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false, databas: 'svarar inte' }, { status: 503 });
  }
}
