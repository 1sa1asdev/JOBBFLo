import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';
import { version } from '../../../src/version.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// For an uptime monitor: is the database reachable, and has the worker
// checked in lately. Public on purpose (middleware.js) and therefore
// says nothing else — no counts and no users. The commit it runs is
// shown, because the deploy workflow needs it and it is no secret:
// the repository is the same code.
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
      // which commit this deployment runs — the deploy workflow waits for it
      version: version(),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false, databas: 'svarar inte' }, { status: 503 });
  }
}
