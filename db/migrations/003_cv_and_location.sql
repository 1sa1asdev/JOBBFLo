-- ============================================================
-- 003: per-search CV + explicit location filter.
--
-- A search can carry its OWN cv (a version tailored for that
-- kind of role). Scoring and letters use:
--     COALESCE(searches.cv_text, profile.cv_text)
-- so an untailored search transparently falls back to the base CV.
-- ============================================================

ALTER TABLE searches ADD COLUMN IF NOT EXISTS cv_text text;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS cv_filename text;

-- the location the user picked in the UI, kept separate from the
-- LLM-authored api_filters so a manual choice is never overwritten
-- when the criteria are re-parsed
ALTER TABLE searches ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS remote_ok boolean;

ALTER TABLE profile ADD COLUMN IF NOT EXISTS cv_uploaded_at timestamptz;
