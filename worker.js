// ------------------------------------------------------------
// The long-running worker (Railway/Fly/Render — NOT Vercel):
//   - IMAP IDLE loop (push, reconnect wrapper)
//   - one global JobStream poll on a timer (never per search)
//   - scan queue: queues ads for searches whose scan_interval elapsed
//   - scoring drain: judges queued ads, one score at a time
//   - follow-up checker (drafts only, never sends)
// Postgres is the only channel to the UI.
// ------------------------------------------------------------
import 'dotenv/config';
import { pool } from './src/db.js';
import { pollJobStream } from './src/fetchJobs.js';
import { scanSearch, scorePending, MAX_SCORE_ATTEMPTS } from './src/score.js';
import { checkFollowups } from './src/followups.js';
import { runAllAutoApply } from './src/autoapply.js';
import { runImapLoop } from './src/imap.js';

const POLL_EVERY = 15 * 60 * 1000;      // JobStream: one global pull
const SCORE_EVERY = 5 * 60 * 1000;      // check which searches are due
const DRAIN_EVERY = 20 * 1000;          // judge queued ads — the user is watching these land
const FOLLOWUP_EVERY = 60 * 60 * 1000;  // follow-up drafts
const AUTOAPPLY_EVERY = 30 * 60 * 1000; // auto-apply campaigns (daily caps do the limiting)

async function pollTick() {
  try {
    await pollJobStream();
  } catch (err) {
    console.error('poll:', err.message);
  }
}

async function scoreTick() {
  try {
    const { rows: due } = await pool.query(
      `SELECT id, name FROM searches
       WHERE deleted_at IS NULL AND scan_enabled
         AND (last_scanned_at IS NULL OR last_scanned_at + scan_interval < now())`
    );
    for (const s of due) {
      await scanSearch(s.id).catch((e) => console.error(`scan ${s.name}:`, e.message));
    }
  } catch (err) {
    console.error('scoreTick:', err.message);
  }
}

// The queue's owner. A request handler that queues ads also kicks off
// its own drain, but that drain dies with the process — a dev-server
// reload or a Vercel function returning leaves rows pending forever.
// This tick is what guarantees a queued ad eventually gets a score,
// so the fire-and-forget above is an optimisation, not the mechanism.
async function drainTick() {
  try {
    const { rows: backlog } = await pool.query(
      `SELECT s.id, s.name, count(*) AS pending
       FROM match_results m
       JOIN searches s ON s.id = m.search_id AND s.deleted_at IS NULL
       WHERE m.score IS NULL AND m.attempts < $1
       GROUP BY s.id, s.name
       ORDER BY count(*) DESC`,
      [MAX_SCORE_ATTEMPTS]
    );
    for (const s of backlog) {
      console.log(`drain: ${s.pending} obedömda i "${s.name}"`);
      await scorePending(s.id, { limit: 20 })
        .catch((e) => console.error(`drain ${s.name}:`, e.message));
    }
  } catch (err) {
    console.error('drainTick:', err.message);
  }
}

// The only path in this app that sends without a per-letter click.
// Campaigns are opt-in per search, capped per day, and pause on the
// first error — see src/autoapply.js for the rails.
async function autoApplyTick() {
  try {
    const results = await runAllAutoApply();
    for (const r of results) {
      if (r.sent) console.log(`auto-apply: ${r.sent} skickade för "${r.search}"`);
      if (r.paused) console.log(`auto-apply: "${r.search}" pausad`);
    }
  } catch (err) {
    console.error('autoApply:', err.message);
  }
}

async function followupTick() {
  try {
    await checkFollowups();
  } catch (err) {
    console.error('followups:', err.message);
  }
}

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());
process.on('SIGTERM', () => abort.abort());

// ------------------------------------------------------------
// Exactly one worker, enforced by Postgres rather than by whoever
// started it. Restarts had been leaking workers, and four of them
// racing meant every ad was scored four times — four times the
// tokens, on a free tier, for one result. The kill filter that
// caused it is fixed, but this is the part that cannot drift: the
// lock is held on a dedicated connection for the process lifetime,
// so it releases only when this process actually dies.
// ------------------------------------------------------------
const WORKER_LOCK = 8123472;
const lockClient = await pool.connect();
const { rows: [lock] } = await lockClient.query(
  'SELECT pg_try_advisory_lock($1) AS got', [WORKER_LOCK]
);
if (!lock.got) {
  console.error('en annan worker kör redan — avslutar (det ska bara finnas en)');
  lockClient.release();
  process.exit(0);
}

console.log('jobbflo worker starting');
pollTick();
scoreTick();
drainTick();
followupTick();
autoApplyTick();
setInterval(pollTick, POLL_EVERY);
setInterval(scoreTick, SCORE_EVERY);
setInterval(drainTick, DRAIN_EVERY);
setInterval(followupTick, FOLLOWUP_EVERY);
setInterval(autoApplyTick, AUTOAPPLY_EVERY);

runImapLoop({ signal: abort.signal }).then(() => {
  console.log('worker stopped');
  process.exit(0);
});
