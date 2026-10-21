// Waits up to three minutes for the production worker's heartbeat to be
// fresh again, then reports.
import pg from 'pg';
import { läsMiljö, pgInställning } from './scripts/miljo.js';
const c = new pg.Client(pgInställning(läsMiljö('production')));
await c.connect();
const sek = (t) => (t ? Math.round((Date.now() - new Date(t)) / 1000) : null);
const slut = Date.now() + 180_000;
let puls;
do {
  const [r] = (await c.query(`SELECT last_run_at FROM poll_state WHERE key = 'imap_worker_alive'`)).rows;
  puls = sek(r?.last_run_at);
  if (puls !== null && puls < 20) break;
  await new Promise((ok) => setTimeout(ok, 5000));
} while (Date.now() < slut);
for (const r of (await c.query(`SELECT key, last_run_at FROM poll_state WHERE key IN ('imap_worker_alive','jobstream','janitor_snapshot','janitor_sweep') ORDER BY key`)).rows) console.log(`${r.key.padEnd(20)} ${sek(r.last_run_at)} s sedan`);
const [a] = (await c.query(`SELECT count(*)::int AS totalt, count(embedding)::int AS embeddade FROM ads`)).rows;
console.log('annonser', JSON.stringify(a));
await c.end();
