-- ------------------------------------------------------------
-- Filter candidates by HOW you apply, before spending a scoring call.
--
-- Only 21% of ads carry an application email (972 of 4731); the rest
-- send you to an ATS or a careers page. A campaign can only ever mail
-- the 21%, yet scoring judged all of them — roughly four out of five
-- LLM calls bought a result that could never be acted on.
--
-- This filter is applied at QUEUE time, not display time. Filtering
-- the list afterwards would still have paid for the scoring; the
-- whole point is that the excluded ads are never sent to a model.
--
--   'email'    only ads with an application address  (cheapest)
--   'any'      no restriction                        (default)
--   'external' only ads that go through a site/ATS
--
-- Ads with neither (7 rows today) are unreachable and match only 'any'.
-- ------------------------------------------------------------

-- NULL is meaningful: "the user has not been asked yet", which is what
-- makes the assistant ask exactly once instead of every scan. It also
-- behaves as 'any' everywhere it is read, so an unanswered search is
-- unrestricted rather than empty.
ALTER TABLE searches
  ADD COLUMN apply_filter text
    CHECK (apply_filter IN ('email', 'any', 'external'));

COMMENT ON COLUMN searches.apply_filter IS
  'Which application methods to score: email | any | external. Applied at queue time so excluded ads cost nothing.';

-- A campaign sends by email or not at all — src/autoapply.js requires
-- apply_email in three places. Scoring link-only ads for a campaign is
-- money spent on candidates it is structurally unable to contact, so
-- every existing campaign moves to 'email'.
UPDATE searches
SET apply_filter = 'email'
WHERE auto_apply_enabled = true;
