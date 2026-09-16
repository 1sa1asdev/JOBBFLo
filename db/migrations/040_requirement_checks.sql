-- ============================================================
-- Grading as a checklist of requirements, not a number a model
-- invented.
--
-- The old verdict was one 0-100 with a sentence. It could not be
-- checked, it was not stable — the same reposted job scored 25 one
-- time and 50 the next — and it was bought again for every search the
-- ad turned up in, even though "does this CV meet these requirements"
-- has nothing to do with which search found the ad.
--
-- So the answer is stored per (ad, CV) and reused by every search:
--
--   items    one row per requirement from the ad, each with the ad's
--            own words and, where the CV answers it, the CV's own
--            words — both verified verbatim before they are stored
--   score    computed in code from those items, so the same checklist
--            always gives the same number and the weighting can change
--            without paying a model again
--
-- cv_key is a hash of the CV the check was made against: a new CV is a
-- new answer, and the old one stays until it is replaced rather than
-- silently describing a CV that no longer exists.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_checks (
  ad_id       uuid NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  cv_key      text NOT NULL,
  items       jsonb NOT NULL DEFAULT '[]'::jsonb,
  score       int,
  summary     text,
  must_missing text[],
  model       text,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ad_id, cv_key)
);

-- What a search's verdict was computed from, so the UI can show the
-- rows behind the number and a re-weighting can find them again.
ALTER TABLE match_results ADD COLUMN IF NOT EXISTS check_cv_key text;
