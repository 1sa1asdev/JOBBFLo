-- ============================================================
-- One verdict per job, and letting go of closed ads properly.
--
-- score_reused_from: a repost gets a new ad id but the same
-- fingerprint, and the scoring queue judged it again from scratch —
-- 18 of 1026 scores, among them Amazon's "DCO Technician" four times
-- over, and ChopChop's "Restaurangmedarbetare 50%" at 25 one time and
-- 50 the next for the same job in the same search. A copied verdict
-- points at the one it came from, so it stays auditable and does not
-- count against the daily scoring budget: no model was paid for it.
--
-- The index serves the twin lookup, which runs once per queued ad.
-- ============================================================
ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS score_reused_from uuid
    REFERENCES match_results(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ads_fingerprint_idx ON ads (fingerprint);

-- Closing an ad is an event worth reacting to, and the retirement pass
-- needs to find the ones still holding derived data without scanning
-- 37,000 rows each time.
CREATE INDEX IF NOT EXISTS ads_closed_with_vector_idx ON ads (id)
  WHERE embedding IS NOT NULL
    AND (removed_at IS NOT NULL OR deadline IS NOT NULL);
