import { Readable } from 'node:stream';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { pool } from './db.js';
import { mapAd, upsertAd } from './fetchJobs.js';

// ------------------------------------------------------------
// The full picture of what is published right now.
//
// The minute-by-minute stream is a feed of CHANGES, and it only reaches
// back so far: the pool it built holds 37.7k open ads where
// Arbetsförmedlingen publishes 43.1k. The missing 5.4k are ads
// published before this app started listening — of 100 sampled from
// the oldest pages, 72 to 81 were not here. A search that reads the
// pool (src/localsearch.js) can only find what the pool holds, so that
// gap is jobs the user never sees.
//
// The snapshot closes it, and does one more thing the stream cannot:
// it says what is NO LONGER published. An ad can leave the list by
// being withdrawn (the stream says so) or simply by its last
// publication date passing (nothing says anything at all). Whatever is
// missing from a full snapshot is no longer live, and the pool should
// say so rather than keep offering it.
//
// It is streamed, never buffered: the payload is several hundred
// megabytes, and JSON.parse on that is a way to run out of memory.
// ------------------------------------------------------------

const SNAPSHOT = 'https://jobstream.api.jobtechdev.se/snapshot';

// Marked, not deleted. An ad row may carry an application, a favourite
// or a paid verdict, and removed_at is the same flag the stream sets
// when it withdraws an ad — retireClosedAds releases what a closed ad
// was holding, pruneStaleAds deletes the ones nobody touched.
async function markaSaknade(sedda, { dryRun }) {
  await pool.query(`CREATE TEMP TABLE IF NOT EXISTS levande (external_id text PRIMARY KEY)`);
  await pool.query('TRUNCATE levande');
  const ids = [...sedda];
  for (let i = 0; i < ids.length; i += 5000) {
    await pool.query(
      `INSERT INTO levande (external_id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`,
      [ids.slice(i, i + 5000)]);
  }

  const villkor = `a.source = 'platsbanken' AND a.removed_at IS NULL
      AND a.external_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM levande l WHERE l.external_id = a.external_id)`;

  if (dryRun) {
    const { rows: [r] } = await pool.query(
      `SELECT count(*)::int AS n FROM ads a WHERE ${villkor}`);
    return r.n;
  }
  const { rowCount } = await pool.query(
    `UPDATE ads a SET removed_at = now() WHERE ${villkor}`);
  return rowCount;
}

export async function importSnapshot({ dryRun = false, signal = null } = {}) {
  const t0 = Date.now();
  const res = await fetch(SNAPSHOT, { headers: { accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);

  const sedda = new Set();
  let nya = 0;
  let ändrade = 0;
  let lästa = 0;

  const client = await pool.connect();
  const rör = chain([Readable.fromWeb(res.body), parser(), streamArray()]);
  try {
    for await (const { value } of rör) {
      lästa += 1;
      if (value?.id != null) sedda.add(String(value.id));
      if (dryRun) continue;
      // An ad that is in the snapshot is published, whatever the stream
      // said earlier: removed comes back as false and the upsert clears
      // removed_at with it.
      const r = await upsertAd(client, mapAd(value));
      if (r?.inserted) nya += 1;
      else if (r && !r.unchanged) ändrade += 1;
      if (lästa % 5000 === 0) {
        console.log(`  snapshot: ${lästa} lästa, ${nya} nya, ${ändrade} ändrade`);
      }
    }
  } finally {
    client.release();
  }

  // Only when the read finished. A truncated download would otherwise
  // read as "everything else is gone" and close the whole pool.
  const stängda = lästa > 1000 ? await markaSaknade(sedda, { dryRun }) : 0;

  const r = { lästa, nya, ändrade, stängda, sekunder: Math.round((Date.now() - t0) / 1000), dryRun };
  console.log(`snapshot: ${lästa} annonser, ${nya} nya, ${ändrade} ändrade, `
    + `${stängda} stängda (${r.sekunder}s)${dryRun ? ' [torrkörning]' : ''}`);
  return r;
}
