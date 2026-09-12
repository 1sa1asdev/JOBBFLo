-- ============================================================
-- The ad, read into the same shape as the CV.
--
-- The CV goes through buildCvProfile and comes out structured:
-- headline, seniority, experience[], skills[{name, field, strength}],
-- domains, languages, constraints. Ads did not. adEmbedText fed the
-- embedder a title plus 2000 characters of whatever prose the source
-- happened to use, and scoreAd read the same raw text.
--
-- So the two sides of every comparison had different shapes, and the
-- shape varied by source: Arbetsförmedlingen's ads are formal and
-- structured, a scraped Teamtailor page is marketing copy, a hand-added
-- lead has no text at all. The same job described two ways scored
-- differently, and that is not a model problem — it is a format
-- problem, and it belongs upstream of the model.
--
-- ad_profile is the ad in the CV's vocabulary: what the role REQUIRES,
-- in the same fields, with the same enum for seniority and the same
-- notion of "field" — so "vård och omsorg" on one side meets "vård och
-- omsorg" on the other rather than having to be inferred across a
-- wall of prose.
--
-- Every fact carries `evidence`, verbatim from the ad, for the same
-- reason the CV facts do (CLAUDE.md #5): a requirement the app cannot
-- point at in the ad text is a requirement it invented.
-- ============================================================
ALTER TABLE ads
  ADD COLUMN ad_profile        jsonb,
  ADD COLUMN ad_profile_at     timestamptz,
  ADD COLUMN ad_profile_model  text;

-- Filled lazily and in priority order, so the column is mostly NULL at
-- any moment and the queue query has to be cheap.
CREATE INDEX ads_needs_profile_idx ON ads (published_at DESC NULLS LAST)
  WHERE ad_profile IS NULL AND removed_at IS NULL;

COMMENT ON COLUMN ads.ad_profile IS
  'The ad read into the CV profile''s vocabulary — see src/adprofile.js. Used for embedding and grading so both sides of the comparison have the same shape.';
