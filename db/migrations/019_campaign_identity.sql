-- ============================================================
-- 1. What actually IS a campaign
--
-- The Kampanjer tab listed every row in `searches`, so an ordinary
-- saved search appeared as a campaign it had never been. Pressing ✕
-- cleared the campaign fields — which on such a row were already empty —
-- and the card stayed exactly where it was. The delete looked broken
-- because there was nothing to delete: the list was not a list of
-- campaigns.
--
-- Being a campaign is a decision the user makes ("Skapa kampanj"), not
-- something to infer from whether a letter happens to exist. An explicit
-- stamp means clearing it removes the campaign and leaves the search —
-- which is the behaviour the ✕ has always claimed.
-- ============================================================
ALTER TABLE searches
  ADD COLUMN campaign_created_at timestamptz;

COMMENT ON COLUMN searches.campaign_created_at IS
  'Set when the user creates a campaign on this search; cleared when they remove it. NULL = an ordinary search, never shown in the Kampanjer list.';

-- Existing rows: anything carrying campaign machinery was one in
-- practice, so keep it visible rather than making it vanish on deploy.
UPDATE searches SET campaign_created_at = created_at
WHERE deleted_at IS NULL
  AND (campaign_letter IS NOT NULL
       OR auto_apply_enabled
       OR EXISTS (SELECT 1 FROM applications a
                  WHERE a.origin_search_id = searches.id AND a.sent_by = 'auto'));

-- ============================================================
-- 2. Campaigns that never pay for a verdict
--
-- candidatesFor required `r.score >= auto_apply_min_score`, and score is
-- NULL until a model has judged the ad. So every campaign candidate had
-- to be scored first — on a branch built specifically to stop scoring
-- ads nobody asked about.
--
-- With this off, the API filters alone decide. That is a real trade: no
-- model reads the ad text, so nothing catches the requirement the
-- taxonomy cannot express. It stays opt-in and defaults to on.
--
-- Note what it does NOT do: an ad that HAS been scored is still held to
-- the threshold. A verdict already paid for is never ignored just
-- because scoring became optional.
-- ============================================================
ALTER TABLE searches
  ADD COLUMN auto_apply_require_score boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN searches.auto_apply_require_score IS
  'false = the campaign may apply to ads no model has judged, using the API filters alone. An ad that already has a score must still clear auto_apply_min_score.';
