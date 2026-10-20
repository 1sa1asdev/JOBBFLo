import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { pool } from '../../../../src/db.js';
import { syncNow, syncSentNow, antalMeddelanden } from '../../../../src/imap.js';
import { harBrevlåda } from '../../../../src/imapManager.js';
import { inomTakt, klientAdress, förMånga } from '../../../../src/takt.js';
import { aktivProfilId } from '../../../../src/auth.js';

export const dynamic = 'force-dynamic';
// Reading a mailbox over IMAP is slower than any other route here — a
// few seconds when there is a backlog — and Next's default would cut it
// off mid-fetch.
export const maxDuration = 60;

// Fetch the presser's mail now, rather than waiting for the worker's
// next pass. Only theirs: the request names their profile, the worker
// answers it with their mailbox, and the count is of their messages.
//
// Two catch-ups overlapping is safe — every insert is keyed on
// message_id, so the worst case is that one of them finds nothing left
// to store.
export async function POST() {
  try {
    const profileId = await aktivProfilId();
    // Each press is a Gmail connection on the user's own account.
    if (!(await inomTakt('hämtaPost', profileId))) return förMånga();

    // Ask the worker first. It holds an open IMAP connection to this
    // user's mailbox, and the expensive part of this is not the reading
    // — it is the opening: 10.5s to connect and 6.7s to open a
    // 28,377-message INBOX, before a single message is fetched. The
    // worker has already paid that, so the same work costs it about two
    // seconds.
    //
    // Postgres is the only channel between the two processes
    // (CLAUDE.md), so the request is a row — one per user.
    const { rows: [w] } = await pool.query(
      `INSERT INTO imap_sync_requests (profile_id, requested_at, done_at, outcome)
       VALUES ($1, now(), NULL, NULL)
       ON CONFLICT (profile_id) DO UPDATE SET requested_at = now(), done_at = NULL, outcome = NULL
       RETURNING requested_at::text AS begärd,
         (SELECT last_run_at FROM poll_state WHERE key = 'imap_worker_alive') AS alive`,
      [profileId]
    );

    // A worker that has not checked in for a minute is not going to
    // answer this one, and neither is one that keeps no mailbox for
    // this user (no letter sent yet, or Gmail refused the password) —
    // so do it here rather than leave the button pressing on nothing.
    // Slow, but slow beats silent.
    const levande = w?.alive && Date.now() - new Date(w.alive).getTime() < 60_000;
    if (levande && await harBrevlåda(profileId)) {
      const före = await antalMeddelanden(profileId);
      // Wait for the worker to say it finished, not for the count to
      // move: with no new mail the count never moves, so waiting on it
      // burned the full timeout every ordinary press.
      let utfall = null;
      for (let i = 0; i < 30 && !utfall; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        const { rows: [s] } = await pool.query(
          `SELECT outcome FROM imap_sync_requests
           WHERE profile_id = $1 AND requested_at = $2::timestamptz AND done_at IS NOT NULL`,
          [profileId, w.begärd]);
        utfall = s?.outcome || null;
      }
      if (utfall === 'klar') {
        const totalt = await antalMeddelanden(profileId);
        return NextResponse.json({ nya: totalt - före, totalt, via: 'worker' });
      }
      // 'ingen brevlåda', an error, or no answer: the worker has no open
      // mailbox for this user right now, so read it from here.
    }

    // Whoever pressed the button: their mailbox, their credentials.
    const r = await syncNow(profileId);
    syncSentNow(profileId).catch((e) => console.error('sent-sync:', e.message));
    return NextResponse.json({ ...r, via: 'direkt' });
  } catch (err) {
    unstable_rethrow(err); // a 401/403 from the auth check is not this route's error
    // Gmail not connected is the user's to fix, not a server failure.
    return NextResponse.json(
      { error: `kunde inte hämta posten: ${err.message}` }, { status: err.status || 502 });
  }
}
