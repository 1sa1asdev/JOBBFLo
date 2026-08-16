-- ============================================================
-- SHORTLIST-FIRST: put a human decision between finding and scoring.
--
-- The old order was find -> score -> user reads scores -> user applies.
-- Scoring was therefore spent on every ad the search matched, and the
-- user applied to a handful. On a 400-ad search that is 400 LLM calls
-- to support maybe 20 applications: 95% of the spend bought verdicts
-- nobody acted on.
--
-- The new order is find -> USER SHORTLISTS -> score -> apply. Finding
-- is free (one API call per page, no model), so the pool can now hold
-- everything the criteria match instead of the first 20. Scoring only
-- ever runs on ads a human already said they were interested in.
--
-- match_results is still the right home and invariant 1 is untouched:
-- one row per (search x ad), created when the ad is found, mutated as
-- it moves through the states below. A candidate is not a second row.
--
-- There are TWO human gates, not one. Shortlisting says "interesting";
-- it is free and reversible and spends nothing. Requesting a score is a
-- separate, deliberate act on specific ads. A favourites tab where
-- favouriting silently triggered an LLM call would just move the old
-- problem behind a click.
--
--   shortlisted_at | score_requested_at | score | meaning
--   ---------------+--------------------+-------+---------------------
--   NULL           | NULL               | NULL  | candidate — free
--   set            | NULL               | NULL  | favourite — still free
--   set            | set                | NULL  | scoring requested
--   set            | set                | set   | scored
--   NULL           | set/NULL           | set   | scored pre-migration
-- ============================================================

ALTER TABLE match_results
  ADD COLUMN shortlisted_at     timestamptz,
  ADD COLUMN score_requested_at timestamptz;

COMMENT ON COLUMN match_results.shortlisted_at IS
  'When the user favourited this ad. Free — favouriting never triggers a model call.';
COMMENT ON COLUMN match_results.score_requested_at IS
  'When the user explicitly asked for a score on THIS ad. The only thing that authorises an LLM call.';

-- Anything already scored was, in the old flow, implicitly of interest —
-- treat it as favourited and requested so it does not reappear as an
-- unreviewed candidate and lose its score's context.
UPDATE match_results
SET shortlisted_at = scored_at, score_requested_at = scored_at
WHERE score IS NOT NULL;

-- The scoring queue: requested but not yet judged. Partial so it stays
-- tiny even when the candidate pool holds thousands of rows.
CREATE INDEX match_results_to_score
  ON match_results (search_id, score_requested_at)
  WHERE score_requested_at IS NOT NULL AND score IS NULL;

-- The candidate list is the new default view and is read constantly.
CREATE INDEX match_results_candidates
  ON match_results (search_id)
  WHERE shortlisted_at IS NULL AND score IS NULL;

-- ------------------------------------------------------------
-- Pagination state. Finding is free, so a search should be able to
-- walk its whole result set rather than re-reading page 1 forever.
-- Arbetsformedlingen returns max 100 per call and accepts an offset,
-- so each scan advances the cursor until the set is exhausted, then
-- resets to 0 to pick up newly published ads.
-- ------------------------------------------------------------
ALTER TABLE searches
  ADD COLUMN fetch_offset  int NOT NULL DEFAULT 0,
  ADD COLUMN fetch_total   int,
  ADD COLUMN fetch_done_at timestamptz;

COMMENT ON COLUMN searches.fetch_offset IS
  'Next offset to request from JobSearch. Advances each scan, wraps to 0 when the result set is exhausted.';
COMMENT ON COLUMN searches.fetch_total IS
  'Total hits the API last reported for these filters — how deep the pool goes.';

-- ------------------------------------------------------------
-- The view gains the shortlist state so the UI can separate the
-- candidate list from the scored list without a second query.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS search_results;
CREATE VIEW search_results AS
SELECT
  m.search_id,
  a.id            AS ad_id,
  a.title,
  a.employer,
  a.municipality,
  a.deadline,
  a.ats_vendor,
  m.score,
  m.summary,
  m.flags,
  (m.score IS NULL) AS pending,
  (m.shortlisted_at IS NOT NULL) AS shortlisted,
  m.shortlisted_at,
  (m.score_requested_at IS NOT NULL) AS score_requested,
  m.score_requested_at,
  m.queued_at,
  m.attempts,
  m.last_error,
  app.status      AS application_status,
  app.sent_at,
  app.origin_search_id,
  (app.id IS NOT NULL AND m.search_id <> app.origin_search_id) AS applied_via_other_search,
  (na.fingerprint IS NOT NULL) AS suppressed
FROM match_results m
JOIN searches s      ON s.id = m.search_id
JOIN ads a           ON a.id = m.ad_id
LEFT JOIN applications app ON app.ad_id = a.id AND app.profile_id = s.profile_id
LEFT JOIN never_apply na   ON na.fingerprint = a.fingerprint
WHERE a.removed_at IS NULL;
