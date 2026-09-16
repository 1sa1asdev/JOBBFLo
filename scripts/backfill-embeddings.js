// Embeds every open ad that has no vector yet, then rebuilds the
// search query vectors.
//
// The pool is what every search now reads, and the ranking inside it is
// vector distance — so an ad without a vector is an ad that sorts last
// whatever it says. After the snapshot import 10k ads were in exactly
// that state.
//
// Prints the spend it caused, because "cheap" should be a number.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { embedPendingAds, embedTexts } from '../src/embed.js';
import { embeddingCoverage, refreshQueryVectors } from '../src/refresh.js';

const BATCH = Number(process.argv[2] || 200);

async function spend() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return null;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${key}` },
    });
    return (await r.json())?.data?.usage ?? null;
  } catch { return null; }
}

const före = await spend();
const t0 = Date.now();
let gjorda = 0;

for (;;) {
  let n = 0;
  try {
    n = await embedPendingAds({ limit: BATCH });
  } catch (err) {
    console.error('paus efter fel:', err.message.slice(0, 120));
    await new Promise((r) => setTimeout(r, 10000));
    continue;
  }
  if (!n) break;
  gjorda += n;
  const c = await embeddingCoverage();
  const takt = gjorda / Math.max(1, (Date.now() - t0) / 1000);
  console.log(`${gjorda} embeddade — ${c.embedded}/${c.total} (${c.pct}%), `
    + `${takt.toFixed(0)}/s, ${Math.round((c.total - c.embedded) / Math.max(takt, 0.1) / 60)} min kvar`);
}

const byggda = await refreshQueryVectors({ maxAgeHours: 0 });
const efter = await spend();
const c = await embeddingCoverage();
console.log(`klart: ${gjorda} annonser, ${byggda} sökvektorer, `
  + `${c.embedded}/${c.total} (${c.pct}%), ${Math.round((Date.now() - t0) / 1000)}s`
  + (före != null && efter != null ? `, kostnad $${(efter - före).toFixed(3)}` : ''));
await pool.end();
