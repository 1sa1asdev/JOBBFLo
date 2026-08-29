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
