-- ============================================================
-- CV PROFILE: understand the CV once, not once per ad.
--
-- The raw CV was pasted verbatim into every scoring call and every
-- letter call, so "what this candidate can do" was never a fact the
-- system held — it was a fresh inference made ~1000 times by whichever
-- cheap model happened to be on the bulk tier. Measured, the same CV
-- and the same ad produced 2 vague skills on a 7B and 5 specific ones
-- naming React/TypeScript/PostgreSQL/Azure on a 120B.
--
-- This runs ONCE per uploaded CV, so it can use the best model
-- available for a fraction of a cent, and the result is reviewable:
-- if it misreads you, you correct it once and every downstream score
-- and letter inherits the correction.
--
-- Every extracted fact carries an `evidence` string that must appear
-- VERBATIM in the CV — the same invariant the ad quotes already obey
-- (CLAUDE.md #5). That makes the profile checkable rather than
-- trusted, and gives letter claims something to be verified against.
-- ============================================================

ALTER TABLE profile
  ADD COLUMN cv_profile       jsonb,
  ADD COLUMN cv_profile_at    timestamptz,
  ADD COLUMN cv_profile_model text;

COMMENT ON COLUMN profile.cv_profile IS
  'Structured understanding of cv_text, built once per upload. Every fact carries verbatim evidence from the CV.';
COMMENT ON COLUMN profile.cv_profile_model IS
  'Which model produced it — a profile built by a weak model should be rebuilt, not trusted.';

-- A search may carry its own tailored CV; it needs its own profile.
ALTER TABLE searches
  ADD COLUMN cv_profile       jsonb,
  ADD COLUMN cv_profile_at    timestamptz,
  ADD COLUMN cv_profile_model text;

-- cv_parsed was only ever read, never written — an empty promise in
-- the schema since the first migration. cv_profile replaces it.
ALTER TABLE profile DROP COLUMN IF EXISTS cv_parsed;
