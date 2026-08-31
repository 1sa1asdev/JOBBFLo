-- ============================================================
-- 1. A self-imposed ceiling on scoring
--
-- Groq's free tier allows 1000 scored ads a day and ~2.9 a minute.
-- 400 is the user's own budget, well under that: a cap you choose is
-- worth more than a cap you discover by hitting it, because the
-- provider's limit arrives as a 429 in the middle of a run.
--
-- It counts scored ads, not requests, because scoring is the only
-- thing that spends. Finding ads stays free and uncapped.
-- ============================================================
ALTER TABLE profile
  ADD COLUMN daily_score_limit int NOT NULL DEFAULT 400
    CHECK (daily_score_limit > 0);

COMMENT ON COLUMN profile.daily_score_limit IS
  'Most ads that may be scored in one calendar day. Counted from match_results.scored_at; finding ads is free and not counted.';

-- ============================================================
-- 2. One letter per employer address — CAMPAIGNS ONLY
--
-- A campaign sends without anyone reading the letter first, so a
-- recruiter who posts four roles must not receive four letters. A new
-- ad from that recruiter carries a new ad_id, so UNIQUE(profile_id,
-- ad_id) never catches it, and reposts and agency listings make that
-- the common case: in the current pool 100 ads with an address resolve
-- to 82 distinct addresses, one recruiter accounting for four.
--
-- Applying by hand is deliberately NOT covered. Two roles at one
-- employer can be worth two letters, and there a human is choosing
-- each time — which is the whole difference between the two paths.
--
-- The index stays scoped to sent_by = 'auto'. What changed is the
-- campaign's candidate query, which now excludes an address reached by
-- ANY route: a campaign must not write to a recruiter the user already
-- mailed themselves. The reverse is fine — a manual letter to an
-- address a campaign used is still the user's call to make.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS applications_auto_one_per_address
  ON applications (profile_id, lower(sent_to))
  WHERE sent_by = 'auto' AND sent_to IS NOT NULL;

COMMENT ON INDEX applications_auto_one_per_address IS
  'One auto-sent letter per employer address per profile. Manual sends are unconstrained by design — a person is choosing each one.';

-- The cap is re-counted before every single ad (a batch-level clamp
-- would let two concurrent drains each spend the whole allowance), so
-- that count has to be cheap rather than a scan of every match_result.
CREATE INDEX match_results_scored_at ON match_results (scored_at)
  WHERE scored_at IS NOT NULL;
