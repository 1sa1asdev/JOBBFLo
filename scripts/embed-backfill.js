// One-off backfill of ad embeddings. The worker keeps up with new ads
// on its own; this is for the first fill, or after a model change.
//
// Batches of 128: per-request overhead dominates, so one call per ad
// would turn six minutes into hours of handshakes.
import 'dotenv/config';
import { embedPendingAds, embedConfig } from '../src/embed.js';
import { embeddingCoverage } from '../src/refresh.js';
import { pool } from '../src/db.js';

const cfg = embedConfig();
console.log(`backfill via ${cfg.provider}:${cfg.model}`);

const t0 = Date.now();
let done = 0;
for (;;) {
  let n;
  try {
    n = await embedPendingAds({ limit: 128 });
  } catch (err) {
    if (!err.transient) {
      // A permanent failure — no credits, bad key, wrong model — is not
      // something the next attempt fixes. The first version of this
      // loop retried a 402 every five seconds indefinitely.
      console.error(`
  avbryter: ${err.message.slice(0, 150)}`);
      break;
    }
    console.error(`
  tillfälligt fel, väntar 5s: ${err.message.slice(0, 90)}`);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  if (!n) break;
  done += n;
  const s = (Date.now() - t0) / 1000;
  const c = await embeddingCoverage();
  const left = c.total - c.embedded;
  const eta = done ? Math.round(left / (done / s)) : 0;
  process.stdout.write(`\r  ${c.embedded}/${c.total} (${c.pct}%)  ${(done/s).toFixed(0)}/s  kvar ~${eta}s   `);
}
console.log(`\nklart på ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await pool.end();
