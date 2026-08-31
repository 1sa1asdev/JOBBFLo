-- ============================================================
-- How a campaign's daily letters are split between its places
--
-- With several locations picked, ordering candidates by score alone
-- sends wherever the ads happen to be. Stockholm has roughly five times
-- Linköping's volume in this pool, so a campaign covering both spends
-- almost every letter on Stockholm — not because the user wanted that
-- ratio, but because that is where the ads are. The daily limit is
-- small (max 20), so this decides nearly the whole outcome.
--
-- Weights, not percentages: {"Stockholm": 2, "Linköping": 1} is easier
-- to reason about than 67/33, needs no validation that it sums to 100,
-- and survives adding a third place without rewriting the other two.
-- Normalised at use.
--
-- A place with no weight, or no ratio at all, means "no preference" —
-- and then score order decides, exactly as before.
-- ============================================================
ALTER TABLE searches
  ADD COLUMN location_ratio jsonb;

COMMENT ON COLUMN searches.location_ratio IS
  'Optional {place: weight} split for the daily letters, keyed by the same names as searches.location. Weights are relative, not percentages. NULL = no preference, score order alone.';
