import { NextResponse } from 'next/server';
import { syncNow } from '../../../../src/imap.js';

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
    const r = await syncNow();
    return NextResponse.json(r);
  } catch (err) {
    return NextResponse.json(
      { error: `kunde inte hämta posten: ${err.message}` }, { status: 502 });
  }
}
