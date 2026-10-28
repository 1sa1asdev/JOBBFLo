import 'dotenv/config';
import { pool } from './src/db.js';
import { importSnapshot } from './src/snapshot.js';
import { retireClosedAds, pruneStaleAds, embeddingCoverage } from './src/refresh.js';
import { fångaProcessfel } from './src/fellogg.js';
import { väntaPåLås, enÅtGången, bevakaLås, anslutMedTålamod } from './src/ensam.js';
import { version } from './src/version.js';

fångaProcessfel('janitor');

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

// One round at a time: a snapshot that outlasts STÄD_VARJE must not
// get a second one started beside it (src/ensam.js enÅtGången).
const varv = enÅtGången(async () => {
  try {
    await snapshot();
    await städa();
  } catch (err) {
    console.error('janitor:', err.message);
  }
});

// One janitor, enforced by Postgres rather than by whoever started it —
// two of them would walk the same snapshot twice and fight over the
// same rows. The lock is held on its own connection for the life of
// the process, so it is released only when this process actually dies.
const LÅS = 8123475;
// Waited for, not given up on: a deploy starts the new container before
// it stops the old one (src/ensam.js).
const avbryt = new AbortController();
process.once('SIGTERM', () => avbryt.abort());
process.once('SIGINT', () => avbryt.abort());
const låskoppling = await anslutMedTålamod(pool, 'janitor', { signal: avbryt.signal });
if (!låskoppling) process.exit(0);
if (!(await väntaPåLås(låskoppling, LÅS, 'janitor', { signal: avbryt.signal }))) {
  låskoppling.release();
  await pool.end();
  process.exit(0);
}

// Timers and shutdown first, so the lock watch below can stop the
// janitor at any moment — including in the middle of its first round.
let timer = null;
let pulsTimer = null;
let avväpnaLås = () => {};
async function stäng(utkod = 0) {
  avväpnaLås();
  clearInterval(timer);
  clearInterval(pulsTimer);
  låskoppling.release();
  await pool.end().catch(() => {});
  process.exit(utkod);
}
process.on('SIGINT', () => stäng(0));
process.on('SIGTERM', () => stäng(0));

// If the lock's connection breaks, Postgres has released the lock and
// another janitor may hold it: stop, and let the host start this again.
avväpnaLås = bevakaLås(låskoppling, 'janitor', () => { stäng(1); });

console.log('jobbflo janitor startar');

// A heartbeat with the commit it runs, once a minute — started before
// the first round, because a snapshot takes minutes and a janitor busy
// with one is alive, not stuck. The deploy workflow reads it to confirm
// a release reached the janitor too (scripts/verify-deploy.js).
const puls = async () => {
  await pool.query(
    `INSERT INTO poll_state (key, last_run_at, note) VALUES ('janitor_alive', now(), $1)
     ON CONFLICT (key) DO UPDATE SET last_run_at = now(), note = EXCLUDED.note`, [version()])
    .catch((e) => console.error('janitor-puls:', e.message));
};
await puls();
pulsTimer = setInterval(puls, 60_000);

await varv();
timer = setInterval(varv, STÄD_VARJE);
