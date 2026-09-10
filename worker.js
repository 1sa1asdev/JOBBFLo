// ------------------------------------------------------------
// The long-running worker (Railway/Fly/Render — NOT Vercel):
//   - IMAP IDLE loop (push, reconnect wrapper)
//   - one global JobStream poll on a timer (never per search)
//   - scan queue: queues ads for searches whose scan_interval elapsed
//   - scoring drain: judges queued ads, one score at a time
//   - embedding: makes new ads rankable without a model call
//   - prune: retires ads nobody touched, keeps anything with history
//   - follow-up checker (drafts only, never sends)
// Postgres is the only channel to the UI.
// ------------------------------------------------------------
import 'dotenv/config';
import { pool } from './src/db.js';
import { pollJobStream } from './src/fetchJobs.js';
import { scanSearch, scorePending, queueSearch, MAX_SCORE_ATTEMPTS } from './src/score.js';
import { checkFollowups } from './src/followups.js';
import { runAllAutoApply } from './src/autoapply.js';
import { scanCampaignLeads } from './src/leadqueue.js';
import { runImapLoop } from './src/imap.js';
import { embedPendingAds, embedSearchQuery } from './src/embed.js';
import {
  pruneStaleAds, embeddingCoverage, releaseExpiredVectors, refreshQueryVectors,
} from './src/refresh.js';

const POLL_EVERY = 15 * 60 * 1000;      // JobStream: one global pull
const SCORE_EVERY = 5 * 60 * 1000;      // check which searches are due
const DRAIN_EVERY = 20 * 1000;          // judge queued ads — the user is watching these land
const FOLLOWUP_EVERY = 60 * 60 * 1000;  // follow-up drafts
const EMBED_EVERY = 60 * 1000;          // embed newly found ads, free and local
const PRUNE_EVERY = 6 * 60 * 60 * 1000; // retire ads nobody touched
// Once a minute, not once every half hour. The pacing lives in the
// campaign now — batch size and a quiet gap between batches — so the
// tick only has to come round often enough to notice when a gap has
// elapsed. A run with nothing due is one cheap query.
const AUTOAPPLY_EVERY = 60 * 1000;
// Reading somebody's application page to find a recruiter. Slow on
// purpose: twelve pages a tick against a backlog of a thousand is
// hours, and that is the right speed for requests to servers that owe
// us nothing. The campaign is not blocked on it either way — this fills
// a list the user confirms from.
const LEADSCAN_EVERY = 4 * 60 * 1000;
const VECTORS_EVERY = 24 * 60 * 60 * 1000;  // release expired vectors, rebuild query vectors

// ------------------------------------------------------------
// New ads reach a campaign because ads arrived, not because an hour
// passed.
//
// A campaign's candidates come from the JobSearch API, walked with a
// cursor that goes deeper every scan. That is right for sweeping a
// pool of 1200, and wrong for today's ad: the cursor may be nine
// hundred in, the scan interval is an hour, and a job posted at 09:00
// could sit unseen until 10:00 while the sweep reads page ten.
//
// So the JobStream poll drives it. When ads actually arrive, every
// enabled campaign checks the FRONT of its result set — one page, no
// model, no cost beyond an HTTP request — and the deep sweep keeps its
// place. Nothing new in the stream means nothing happens.
async function pollTick() {
  try {
    const r = await pollJobStream();
    const nya = (r?.created || 0) + (r?.updated || 0);
    if (!nya) return;

    const { rows: kampanjer } = await pool.query(
      `SELECT id, name FROM searches
       WHERE deleted_at IS NULL AND scan_enabled AND auto_apply_enabled
         AND campaign_created_at IS NOT NULL`
    );
    for (const k of kampanjer) {
      try {
        const { found } = await queueSearch(k.id, { pages: 1, fromStart: true });
        if (found) console.log(`nya annonser: ${found} till "${k.name}"`);
      } catch (e) {
        console.error(`färsk-svep ${k.name}:`, e.message);
      }
    }
  } catch (err) {
    console.error('poll:', err.message);
  }
}

async function scoreTick() {
  try {
    // Two different jobs wearing one name.
    //
    // KEEPING UP with new ads is what scan_interval is for: one page an
    // hour is plenty, and JobStream is a public API worth being polite
    // to.
    //
    // The FIRST SWEEP is not that. A campaign covering three cities
    // matched 1172 ads, and at one page an hour it would take twelve
    // hours before the user could see their own pool — while the search
    // looks broken and half-empty. Finding costs nothing (no model, just
    // the API), so an unfinished sweep runs several pages a tick and
    // ignores the interval until it is done.
    const { rows: due } = await pool.query(
      `SELECT id, name, (fetch_done_at IS NULL) AS first_sweep
       FROM searches
       WHERE deleted_at IS NULL AND scan_enabled
         AND (fetch_done_at IS NULL
              OR last_scanned_at IS NULL
              OR last_scanned_at + scan_interval < now())`
    );
    for (const s of due) {
      await scanSearch(s.id, { pages: s.first_sweep ? 5 : 1 })
        .catch((e) => console.error(`scan ${s.name}:`, e.message));
    }
  } catch (err) {
    console.error('scoreTick:', err.message);
  }
}

// Finishes scoring the user explicitly asked for. A request handler
// kicks off its own drain, but that drain dies with the process — a
// dev-server reload leaves requested rows unscored. This tick is what
// guarantees a REQUESTED ad eventually gets its verdict.
//
// It must never pick up plain candidates: the pool can hold thousands
// of ads nobody asked about, and draining those is precisely the spend
// this branch exists to prevent.
async function drainTick() {
  try {
    const { rows: backlog } = await pool.query(
      // The conditions have to be the drainer's, not a subset of them.
      // Counting rows drainQueue then refuses to touch made this log
      // "drain: 1 begärda bedömningar" every twenty seconds forever —
      // the ad had been withdrawn by Arbetsförmedlingen, so it was
      // correctly skipped and incorrectly counted.
      `SELECT s.id, s.name, count(*) AS pending
       FROM match_results m
       JOIN searches s ON s.id = m.search_id AND s.deleted_at IS NULL
       JOIN ads a ON a.id = m.ad_id
       LEFT JOIN never_apply na ON na.fingerprint = a.fingerprint
       WHERE m.score_requested_at IS NOT NULL   -- candidates are NOT a backlog
         AND m.score IS NULL AND m.attempts < $1
         AND a.removed_at IS NULL
         AND na.fingerprint IS NULL
         AND (a.deadline IS NULL OR a.deadline >= current_date)
       GROUP BY s.id, s.name
       ORDER BY count(*) DESC`,
      [MAX_SCORE_ATTEMPTS]
    );
    for (const s of backlog) {
      console.log(`drain: ${s.pending} begärda bedömningar i "${s.name}"`);
      await scorePending(s.id, { limit: 20 })
        .catch((e) => console.error(`drain ${s.name}:`, e.message));
    }
  } catch (err) {
    console.error('drainTick:', err.message);
  }
}

// Embedding is the cheap half of matching: computed once per ad, then
// every future ranking is vector arithmetic instead of a model call.
// It runs in small batches on a short timer so new ads become rankable
// within a minute or two of being found, rather than in one long
// backfill that blocks everything else.
//
// A failure here is not worth shouting about — the ad simply stays
// unranked and the next tick retries it — so this logs quietly unless
// something is actually wrong.
// Off by default, because it costs money per ad and nothing reads the
// vectors yet. Checked here rather than inside embedPendingAds so the
// switch governs the SCHEDULED spend specifically — a deliberate
// backfill run by hand can still say otherwise.
let embedQuiet = false;
async function embedTick() {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT embeddings_enabled FROM profile LIMIT 1`);
    if (!p?.embeddings_enabled) return;

    // A changed purpose must not keep ranking against the old one, and
    // that cannot wait for the daily tick — the user changes criteria
    // and expects the next scan to reflect it.
    const { rows: stale } = await pool.query(
      `SELECT id, name FROM searches
       WHERE deleted_at IS NULL AND criteria_changed_at IS NOT NULL
         AND (query_embedded_at IS NULL OR query_embedded_at < criteria_changed_at)
       LIMIT 5`
    );
    for (const s2 of stale) {
      await embedSearchQuery(s2.id)
        .then(() => console.log(`embed: sökvektor för "${s2.name}"`))
        .catch((e) => console.error(`embed sökvektor ${s2.name}:`, e.message.slice(0, 90)));
    }

    const n = await embedPendingAds({ limit: 64 });
    if (n) {
      const c = await embeddingCoverage();
      console.log(`embed: ${n} annonser (${c.embedded}/${c.total}, ${c.pct}%)`);
      embedQuiet = false;
    }
  } catch (err) {
    if (!embedQuiet) {
      console.error('embed:', err.message.slice(0, 130));
      embedQuiet = true;   // say it once, not every minute
    }
  }
}

// Daily vector maintenance: release the vectors of ads whose own
// deadline has passed, and rebuild the query vectors the ranking is
// measured against. Skipped entirely while embedding is switched off —
// rebuilding a query vector costs money like any other embedding.
async function vectorsTick() {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT embeddings_enabled FROM profile LIMIT 1`);
    if (!p?.embeddings_enabled) return;
    await releaseExpiredVectors();
    await refreshQueryVectors();
  } catch (err) {
    console.error('vectors:', err.message.slice(0, 130));
  }
}

// Retire ads that no longer exist. Never touches one with an
// application, a favourite or a score — see src/refresh.js for why
// that rule is load-bearing rather than merely polite.
async function pruneTick() {
  try {
    await pruneStaleAds();
  } catch (err) {
    console.error('prune:', err.message);
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

async function leadScanTick() {
  try {
    const r = await scanCampaignLeads();
    if (r.text?.named) console.log(`adresser: ${r.text.named} ur annonstexten`);
    if (r.verified?.godkända) {
      console.log(`adresser: ${r.verified.godkända} verifierade och tillagda i kampanjen`);
    }
    if (r.named || r.shared) {
      console.log(`adresser: ${r.named} kontaktpersoner, ${r.shared} delade inkorgar `
        + `av ${r.pages} lästa sidor`);
    }
  } catch (err) {
    console.error('leadScan:', err.message);
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
embedTick();
pruneTick();
vectorsTick();
followupTick();
autoApplyTick();
setInterval(pollTick, POLL_EVERY);
setInterval(scoreTick, SCORE_EVERY);
setInterval(drainTick, DRAIN_EVERY);
setInterval(followupTick, FOLLOWUP_EVERY);
setInterval(embedTick, EMBED_EVERY);
setInterval(pruneTick, PRUNE_EVERY);
setInterval(vectorsTick, VECTORS_EVERY);
setInterval(autoApplyTick, AUTOAPPLY_EVERY);
setInterval(leadScanTick, LEADSCAN_EVERY);

runImapLoop({ signal: abort.signal }).then(() => {
  console.log('worker stopped');
  process.exit(0);
});
