-- ============================================================
-- Two vectors per ad, because there are two questions.
--
--   embedding          the ad as written, matched against the search's
--                      criteria: "is this the kind of job I asked for"
--   profile_embedding  the ad read into requirements, matched against
--                      the CV read into the same shape: "could I do it"
--
-- Keeping them apart is the point. Measured against the checklist's own
-- scores on 23 ads:
--
--   ad text  vs criteria     0.26        (what ranking did before)
--   profile  vs CV profile   0.45
--   25/75 blend              0.45
--
-- And the reason not to simply replace one with the other is an older
-- measurement, in src/embed.js: rendering every ad into the same
-- "## ROLL / ## KRAV" shape costs 14-20% of discrimination, because
-- every ad starts to read like every other ad. That is fine for
-- answering "can I do it" and bad for "is this what I searched for".
-- One vector each, and the ranking decides how much of each it wants.
-- ============================================================
ALTER TABLE ads ADD COLUMN IF NOT EXISTS profile_embedding vector(768);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS profile_embedded_at timestamptz;

-- Only open ads are ever ranked, and the index is built the same way
-- the text one is.
CREATE INDEX IF NOT EXISTS ads_profile_vec_idx
  ON ads USING hnsw (profile_embedding vector_cosine_ops)
  WHERE removed_at IS NULL;
