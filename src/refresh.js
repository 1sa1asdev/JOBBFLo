import { pool } from './db.js';

// ------------------------------------------------------------
// The steady refresh: retire ads that no longer exist, so the pool
// tracks the live market instead of growing forever.
//
// THE RULE THAT MATTERS: ads.id cascades to BOTH match_results and
// applications. Deleting an ad you applied to would delete the
// application with it — the record of who you wrote to, when, and the
// message_id that reply matching depends on. Measured on this data:
// 3781 ads are old, and 68 of them are load-bearing.
//
// So an ad is only ever removed when nobody has touched it: no
// application, no favourite, no score. Everything else is kept
// regardless of age. Disk is cheap; history is not.
// ------------------------------------------------------------

const PRUNABLE = `
  FROM ads a
  WHERE (a.removed_at IS NOT NULL
         OR (a.deadline IS NOT NULL AND a.deadline < current_date - ($1)::int))
    AND NOT EXISTS (SELECT 1 FROM applications ap WHERE ap.ad_id = a.id)
    AND NOT EXISTS (
      SELECT 1 FROM match_results m
      WHERE m.ad_id = a.id
        AND (m.shortlisted_at IS NOT NULL OR m.score IS NOT NULL))`;

// How long past its deadline an untouched ad is kept. A few days of
// grace so an ad that expires mid-review does not vanish under the
// user while they are reading it.
const GRACE_DAYS = 7;

export async function pruneStaleAds({ dryRun = false, graceDays = GRACE_DAYS } = {}) {
  const { rows: [pre] } = await pool.query(
    `SELECT count(*)::int AS n ${PRUNABLE}`, [graceDays]);

  const { rows: [kept] } = await pool.query(
    `SELECT count(*)::int AS n FROM ads a
     WHERE (a.removed_at IS NOT NULL
            OR (a.deadline IS NOT NULL AND a.deadline < current_date - $1::int))
       AND (EXISTS (SELECT 1 FROM applications ap WHERE ap.ad_id = a.id)
         OR EXISTS (SELECT 1 FROM match_results m WHERE m.ad_id = a.id
                      AND (m.shortlisted_at IS NOT NULL OR m.score IS NOT NULL)))`,
    [graceDays]);

  if (dryRun) return { wouldDelete: pre.n, protectedByHistory: kept.n, deleted: 0 };

  const { rowCount } = await pool.query(
    `DELETE FROM ads WHERE id IN (SELECT a.id ${PRUNABLE})`, [graceDays]);

  if (rowCount) {
    console.log(`rensat ${rowCount} utgångna annonser (${kept.n} gamla behållna — de har historik)`);
  }
  return { deleted: rowCount, protectedByHistory: kept.n };
}

// How much of the pool is currently rankable without a model call.
export async function embeddingCoverage() {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS total,
            count(embedding)::int AS embedded,
            count(DISTINCT embedding_model) AS models
     FROM ads WHERE removed_at IS NULL`);
  return {
    ...r,
    pct: r.total ? Math.round((r.embedded / r.total) * 100) : 0,
  };
}

// ------------------------------------------------------------
// Vector hygiene, run on a daily tick.
//
// Two jobs, and they are separate on purpose.
// ------------------------------------------------------------

// 1. Let go of vectors for ads that can no longer be applied to.
//
// Expiry is per ad, not per day: each vector is released when THAT ad's
// own sista ansökningsdag passes, so the index holds only ads still
// worth ranking. The ad row itself stays — pruneStaleAds owns deleting
// those, and an expired ad may still carry an application's history.
//
// Nothing re-embeds them afterwards, because embedPendingAds now skips
// anything past its deadline. Without that pairing this would be an
// expensive loop: release, re-embed, release again, every single day.
export async function releaseExpiredVectors() {
  const { rowCount } = await pool.query(
    `UPDATE ads SET embedding = NULL, embedding_model = NULL, embedded_at = NULL
     WHERE embedding IS NOT NULL
       AND deadline IS NOT NULL
       AND deadline < current_date`
  );
  if (rowCount) console.log(`vektorer: släppte ${rowCount} utgångna annonser`);
  return rowCount;
}

// 2. Rebuild the query vectors the ranking measures against.
//
// A search's vector is built from its criteria AND the CV profile, so it
// goes stale for a reason the search itself never records: editing the
// CV changes what "similar to me" means, while criteria_changed_at does
// not move. Refreshed daily rather than on a trigger because the cost is
// one small embedding per search — cheaper than the bookkeeping needed
// to know precisely when it was needed.
export async function refreshQueryVectors({ maxAgeHours = 24 } = {}) {
  const { embedSearchQuery } = await import('./embed.js');
  const { rows } = await pool.query(
    `SELECT id, name FROM searches
     WHERE deleted_at IS NULL
       AND (query_embedding IS NULL
            OR query_embedded_at IS NULL
            OR query_embedded_at < now() - ($1 || ' hours')::interval)`,
    [String(maxAgeHours)]
  );
  let done = 0;
  for (const s of rows) {
    try { await embedSearchQuery(s.id); done += 1; }
    catch (err) { console.error(`vektor "${s.name}":`, err.message.slice(0, 90)); }
  }
  if (done) console.log(`vektorer: byggde om ${done} sökvektorer`);
  return done;
}
