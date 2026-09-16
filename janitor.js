import 'dotenv/config';
import { pool } from './src/db.js';
import { importSnapshot } from './src/snapshot.js';
import { retireClosedAds, pruneStaleAds, embeddingCoverage } from './src/refresh.js';

// ------------------------------------------------------------
// The janitor: one small process whose whole job is keeping the ad
// pool honest.
//
// It exists because the pool is now the only source a search reads
// (src/localsearch.js), which makes two failures expensive that used
// to be merely untidy:
//
//   MISSING ADS   the stream is a feed of changes and reaches back
//                 only so far — 5.4k currently published ads were
//                 never seen by it, and a search cannot find what the
//                 pool does not hold
//   DEAD ADS      an ad leaves the list either by being withdrawn
//                 (the stream says so) or by its publication simply
//                 running out (nothing says anything), and a pool that
//                 keeps offering those is a campaign writing to jobs
//                 that no longer exist
//
// Kept apart from the main worker on purpose. The snapshot is hundreds
// of megabytes and takes minutes to walk; running it inside the worker
// would stall the IMAP loop, the campaign tick and the scoring drain
// while it ran. Here it can be slow, and it can be restarted, without
// touching anything the user is looking at.
// ------------------------------------------------------------

const TIMME = 60 * 60 * 1000;
const SNAPSHOT_VARJE = Number(process.env.JANITOR_SNAPSHOT_HOURS || 24) * TIMME;
const STÄD_VARJE = Number(process.env.JANITOR_SWEEP_HOURS || 6) * TIMME;

const status = async (key) => {
  const { rows: [r] } = await pool.query(
    `SELECT last_run_at, note FROM poll_state WHERE key = $1`, [key]);
  return r || null;
};

const stämpla = async (key, note) => {
  await pool.query(
    `INSERT INTO poll_state (key, cursor_ts, last_run_at, note)
     VALUES ($1, now(), now(), $2)
     ON CONFLICT (key) DO UPDATE SET last_run_at = now(), note = EXCLUDED.note`,
    [key, note?.slice(0, 300) || null]);
};

// Deadlines pass with the clock, not with an event: nothing arrives to
// say that yesterday's last application day is over. This is the sweep
// that notices, and it runs whether or not the snapshot did.
async function städa() {
  const stängda = await retireClosedAds();
  const rensade = await pruneStaleAds();
  const täckning = await embeddingCoverage();
  await stämpla('janitor_sweep',
    `${stängda.vektorer} vektorer, ${stängda.kandidater} kandidater, `
    + `${rensade.deleted} borttagna, ${täckning.pct}% embeddade`);
  console.log(`städat: ${rensade.deleted} annonser borta, ${rensade.protectedByHistory} behållna `
    + `(historik), ${täckning.embedded}/${täckning.total} embeddade`);
}

async function snapshot() {
  const s = await status('janitor_snapshot');
  const ålder = s?.last_run_at ? Date.now() - new Date(s.last_run_at).getTime() : Infinity;
  if (ålder < SNAPSHOT_VARJE) return false;

  console.log('snapshot: hämtar hela listan…');
  try {
    const r = await importSnapshot();
    await stämpla('janitor_snapshot',
      `${r.lästa} lästa, ${r.nya} nya, ${r.stängda} stängda, ${r.sekunder}s`);
    return true;
  } catch (err) {
    // A failed snapshot is not an emergency: the stream keeps the pool
    // current for everything published since it started, and the next
    // run tries again. The stamp is deliberately NOT written, so a
    // failure does not count as "done for today".
    console.error('snapshot:', err.message.slice(0, 200));
    await stämpla('janitor_snapshot_fel', err.message);
    return false;
  }
}

async function varv() {
  try {
    await snapshot();
    await städa();
  } catch (err) {
    console.error('janitor:', err.message);
  }
}

// One janitor, enforced by Postgres rather than by whoever started it —
// two of them would walk the same snapshot twice and fight over the
// same rows. The lock is held on its own connection for the life of
// the process, so it is released only when this process actually dies.
const LÅS = 8123475;
const låskoppling = await pool.connect();
const { rows: [lås] } = await låskoppling.query('SELECT pg_try_advisory_lock($1) AS ok', [LÅS]);
if (!lås.ok) {
  console.log('en annan janitor kör redan — avslutar');
  låskoppling.release();
  await pool.end();
  process.exit(0);
}

console.log('jobbflo janitor startar');
await varv();
const timer = setInterval(varv, STÄD_VARJE);

const stäng = async () => {
  clearInterval(timer);
  låskoppling.release();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', stäng);
process.on('SIGTERM', stäng);
