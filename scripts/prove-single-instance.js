// Proves a deploy can never leave zero workers, nor two.
//
//   node scripts/prove-single-instance.js
//
// What took production down: Railway starts a deploy's new container
// before it stops the old one. The new worker saw the old one's lock and
// exited; then the old one was stopped, and none was left.
//
//   1. while the old one holds the lock, the new one waits — it neither
//      runs alongside nor exits
//   2. the moment the old one's connection closes, the new one takes over
//   3. a waiting instance that is told to stop (SIGTERM) leaves quietly,
//      without the lock
//   4. inside the one instance, a tick still running when its timer
//      fires again is skipped, not started twice — and runs again once
//      it is done, failed or not (enÅtGången). On 21 Oct a slow database
//      got three embedding batches on top of each other and the worker
//      starved the app.
//
// On throwaway connections to DATABASE_URL; the lock key is this run's own.
import 'dotenv/config';
import pg from 'pg';
import { anslutning } from '../src/dbConfig.js';
import { väntaPåLås, enÅtGången } from '../src/ensam.js';

const NYCKEL = 900000 + (process.pid % 90000);
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(62)}${info ? ` ${info}` : ''}`);
};
const koppling = async () => { const c = new pg.Client(anslutning()); await c.connect(); return c; };

const gammal = await koppling();
const ny = await koppling();
const tredje = await koppling();
try {
  await gammal.query('SELECT pg_advisory_lock($1)', [NYCKEL]);

  // ---- 1 + 2 ----
  let fick = null;
  const start = Date.now();
  const väntan = väntaPåLås(ny, NYCKEL, 'bevis', { intervall: 150 }).then((v) => { fick = v; });
  await new Promise((ok) => setTimeout(ok, 700));
  kolla('1. medan den gamla håller låset väntar den nya', fick === null);
  await gammal.end(); // the old container is stopped: its connection closes
  await väntan;
  const tog = Date.now() - start;
  kolla('2. när den gamla stängs tar den nya över', fick === true, `${tog} ms`);
  const { rows: [r] } = await tredje.query('SELECT pg_try_advisory_lock($1) AS fick', [NYCKEL]);
  kolla('2. och låset är nu den nyas — ingen tredje kommer in', r.fick === false);

  // ---- 3 ----
  const avbryt = new AbortController();
  const väntande = väntaPåLås(tredje, NYCKEL, 'bevis', { intervall: 150, signal: avbryt.signal });
  await new Promise((ok) => setTimeout(ok, 300));
  avbryt.abort();
  kolla('3. en väntande instans som stoppas går utan låset', (await väntande) === false);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.message);
} finally {
  for (const c of [gammal, ny, tredje]) await c.end().catch(() => {});
}

// ---- 4 ----
{
  let körs = 0; let samtidigt = 0; let flest = 0; let släpp; let fallera = false;
  const tick = enÅtGången(async () => {
    körs += 1; samtidigt += 1; flest = Math.max(flest, samtidigt);
    try {
      await new Promise((ok) => { släpp = ok; });
      if (fallera) throw new Error('tick föll');
    } finally { samtidigt -= 1; }
  });
  const första = tick();
  for (let i = 0; i < 5; i += 1) await tick(); // the timer fires five more times meanwhile
  kolla('4. en tick som pågår startas inte igen', körs === 1 && flest === 1, `${körs} körningar`);
  släpp(); await första;
  fallera = true;
  const andra = tick().catch(() => 'föll');
  släpp();
  kolla('4. när den är klar körs den igen', körs === 2 && (await andra) === 'föll');
  fallera = false;
  const tredje = tick(); släpp(); await tredje;
  kolla('4. också efter en tick som föll', körs === 3);
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
