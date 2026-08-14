// ------------------------------------------------------------
// The long-running worker (Railway/Fly/Render — NOT Vercel):
//   - IMAP IDLE loop (push, reconnect wrapper)
//   - one global JobStream poll on a timer (never per search)
//   - scoring queue: scores searches whose scan_interval elapsed
//   - follow-up checker (drafts only, never sends)
// Postgres is the only channel to the UI.
// ------------------------------------------------------------
import 'dotenv/config';
import { pool } from './src/db.js';
import { pollJobStream } from './src/fetchJobs.js';
import { scanSearch } from './src/score.js';
import { checkFollowups } from './src/followups.js';
import { runAllAutoApply } from './src/autoapply.js';
import { runImapLoop } from './src/imap.js';

const POLL_EVERY = 15 * 60 * 1000;      // JobStream: one global pull
const SCORE_EVERY = 5 * 60 * 1000;      // check which searches are due
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

console.log('jobbflo worker starting');
pollTick();
scoreTick();
followupTick();
autoApplyTick();
setInterval(pollTick, POLL_EVERY);
setInterval(scoreTick, SCORE_EVERY);
setInterval(followupTick, FOLLOWUP_EVERY);
setInterval(autoApplyTick, AUTOAPPLY_EVERY);

runImapLoop({ signal: abort.signal }).then(() => {
  console.log('worker stopped');
  process.exit(0);
});
