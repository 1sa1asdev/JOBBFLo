import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { syncNow, syncSentNow } from '../../../../src/imap.js';

const antalMeddelanden = async () => (
  await pool.query('SELECT count(*)::int AS n FROM email_messages')
).rows[0].n;

export const dynamic = 'force-dynamic';
// Reading a mailbox over IMAP is slower than any other route here — a
// few seconds when there is a backlog — and Next's default would cut it
// off mid-fetch.
export const maxDuration = 60;

// Fetch mail now, rather than waiting for the worker's next pass.
//
// Serialised by a Postgres advisory lock inside the worker's own
// ingest? No — this opens its own connection, and the guard that makes
// that safe is per-message: every insert is keyed on message_id, so the
// worst case of two catch-ups overlapping is that one of them finds
// nothing left to store.
export async function POST() {
  try {
    // Ask the worker first. It holds an open IMAP connection, and the
    // expensive part of this is not the reading — it is the opening:
    // 10.5s to connect and 6.7s to open a 28,377-message INBOX, before
    // a single message is fetched. The worker has already paid that and
    // never pays it again, so the same work costs it about two seconds.
    //
    // Postgres is the only channel between the two processes
    // (CLAUDE.md), so the request is a row. The worker checks it every
    // few seconds.
    const { rows: [w] } = await pool.query(
      `INSERT INTO poll_state (key, cursor_ts, note)
       VALUES ('imap_sync_request', now(), 'ui')
       ON CONFLICT (key) DO UPDATE SET cursor_ts = now(), note = 'ui'
       RETURNING (SELECT last_run_at FROM poll_state WHERE key = 'imap_worker_alive') AS alive`
    );

    // A worker that has not checked in for a minute is not going to
    // answer this one, so do it here rather than leave the button
    // pressing on nothing. Slow, but slow beats silent.
    const levande = w?.alive && Date.now() - new Date(w.alive).getTime() < 60_000;
    if (levande) {
      const före = await antalMeddelanden();
      // Wait for the worker to say it finished, not for the count to
      // move: with no new mail the count never moves, so waiting on it
      // burned the full timeout every ordinary press.
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        const { rows: [p2] } = await pool.query(
          `SELECT note, last_run_at >= cursor_ts AS klar
           FROM poll_state WHERE key = 'imap_sync_request'`);
        if (p2?.klar && p2.note === 'klar') break;
      }
      const totalt = await antalMeddelanden();
      return NextResponse.json({ nya: totalt - före, totalt, via: 'worker' });
    }

    const r = await syncNow();
    syncSentNow().catch((e) => console.error('sent-sync:', e.message));
    return NextResponse.json({ ...r, via: 'direkt' });
  } catch (err) {
    return NextResponse.json(
      { error: `kunde inte hämta posten: ${err.message}` }, { status: 502 });
  }
}
