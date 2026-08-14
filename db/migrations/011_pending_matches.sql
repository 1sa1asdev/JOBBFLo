-- ------------------------------------------------------------
-- Split "found" from "judged".
--
-- Before this, an ad only existed for a search once the LLM had
-- scored it, so the list stayed empty for the whole scan. On a cheap
-- model that is minutes of blank screen for work that was already
-- done: the ads came back from Arbetsförmedlingen in about a second.
--
-- A match_result now exists from the moment layer 1 selects the ad,
-- with score NULL meaning "queued, not judged yet". The UI can show
-- the ad immediately and fill the score in when it lands.
--
-- This does NOT weaken invariant 1. match_results is still one row
-- per (search x ad) and UNIQUE(search_id, ad_id) still holds — a
-- pending row is the same row that later gets its score, not a new
-- one. Nothing about application state moves here.
-- ------------------------------------------------------------

ALTER TABLE match_results ALTER COLUMN score DROP NOT NULL;
ALTER TABLE match_results ALTER COLUMN summary DROP NOT NULL;
-- scored_at now means "when it was judged", NULL while queued.
ALTER TABLE match_results ALTER COLUMN scored_at DROP NOT NULL;
ALTER TABLE match_results ALTER COLUMN scored_at DROP DEFAULT;

-- The existing CHECK (score BETWEEN 0 AND 100) stays as-is: with a
-- NULL score it evaluates to NULL, which a CHECK accepts. A real
-- score is still forced into range.

ALTER TABLE match_results
  ADD COLUMN queued_at     timestamptz NOT NULL DEFAULT now(),
  -- prefilter confidence, set for free at queue time. Drains
  -- best-first so the ads most likely to matter get a score first.
  ADD COLUMN queue_rank    real,
  -- a model that fails on one ad must not wedge the queue forever
  ADD COLUMN attempts      int NOT NULL DEFAULT 0,
  ADD COLUMN last_error    text;

-- rows already scored predate the queue; keep their timeline honest
UPDATE match_results SET queued_at = scored_at WHERE scored_at IS NOT NULL;

-- the queue drain hits this constantly; partial so it stays tiny
CREATE INDEX match_results_pending
  ON match_results (search_id, queue_rank DESC NULLS LAST)
  WHERE score IS NULL;

-- ------------------------------------------------------------
-- The view gains `pending` so the UI can tell "no score yet" from
-- "scored 0". Everything else is unchanged — application status is
-- still a JOIN, never a stored column.
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
