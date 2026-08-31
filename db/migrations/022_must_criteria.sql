-- ============================================================
-- A hard requirement in plain Swedish, per campaign
--
-- criteria_text becomes API filters, so it can only express what the
-- taxonomy has a concept for. "Bara juniora utvecklarroller" is not
-- one: seniority is written in the ad's prose, and layer 1 either
-- drops it or smuggles it into a free-text q where it matches the word
-- rather than the meaning. The campaign then applies to senior roles
-- and the user finds out from the replies.
--
-- This is the other half: text the MODEL reads while judging the ad,
-- as a gate rather than a preference. Failing it caps the score, so
-- the ad falls under auto_apply_min_score and no letter is sent.
--
-- It therefore only works when the campaign actually scores. With
-- auto_apply_require_score off there is no model in the loop and
-- nothing can enforce it — the UI has to say so rather than let the
-- user write a rule that silently does nothing.
-- ============================================================
ALTER TABLE searches
  ADD COLUMN must_criteria text;

COMMENT ON COLUMN searches.must_criteria IS
  'Free-text hard requirement judged by the model during scoring, e.g. "bara juniora roller". Caps the score when unmet. Requires auto_apply_require_score = true to have any effect.';
