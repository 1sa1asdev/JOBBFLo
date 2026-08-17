-- ============================================================
-- Changing the criteria must not destroy the shortlist.
--
-- src/chat.js deleted every match_results row for the search whenever
-- the criteria changed. Under the old flow that was defensible: rows
-- were purely derived, scoring ran automatically, and re-scoring was
-- the intended behaviour.
--
-- Under shortlist-first it destroys two things that are not derived:
--   * favourites — a human decision, made one ad at a time
--   * scores — verdicts the user explicitly paid for
--
-- Plain candidates are still free to re-find, so those may go. What
-- must not is anything a person touched or paid for.
--
-- A score made against the OLD criteria is now stale rather than
-- wrong-and-deleted, so we record when the criteria last changed.
-- `scored_at < criteria_changed_at` makes staleness derivable without
-- another column on match_results, and lets the UI offer a re-score
-- instead of silently discarding one.
-- ============================================================

ALTER TABLE searches
  ADD COLUMN criteria_changed_at timestamptz;

COMMENT ON COLUMN searches.criteria_changed_at IS
  'When criteria_text last changed. A match_result scored before this was judged against different criteria — stale, not invalid.';

-- Existing scores predate any recorded change, so nothing is stale yet.
UPDATE searches SET criteria_changed_at = created_at WHERE criteria_changed_at IS NULL;
