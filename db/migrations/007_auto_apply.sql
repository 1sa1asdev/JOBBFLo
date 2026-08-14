-- ============================================================
-- 007: auto-apply campaigns.
--
-- CLAUDE.md's invariant #2 said nothing sends without per-letter
-- approval. This deliberately replaces that with CAMPAIGN approval:
-- the user configures a rule ("apply to anything scoring >= N in
-- this search, max M per day"), previews a sample letter, and turns
-- it on. That is a considered decision by the spec's owner, not a
-- bypass — so the rails below are what keep it honest.
--
-- Hard rails, enforced in src/autoapply.js:
--   - a CV file must exist (the ad asked for one)
--   - the ad must publish apply_email (we never guess an address)
--   - UNIQUE(profile_id, ad_id) already prevents applying twice
--   - daily cap per search AND global
--   - any send error pauses the campaign rather than retrying
-- ============================================================

ALTER TABLE searches ADD COLUMN IF NOT EXISTS auto_apply_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS auto_apply_min_score int NOT NULL DEFAULT 85;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS auto_apply_daily_limit int NOT NULL DEFAULT 3;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS auto_apply_paused_reason text;

-- how each application came to be sent, so the inbox can show it and
-- an audit is possible after the fact
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sent_by text
  NOT NULL DEFAULT 'user' CHECK (sent_by IN ('user','auto'));

CREATE TABLE IF NOT EXISTS auto_apply_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id    uuid REFERENCES searches(id) ON DELETE SET NULL,
  ad_id        uuid REFERENCES ads(id) ON DELETE SET NULL,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  score        int,
  outcome      text NOT NULL,        -- sent | skipped | failed
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auto_apply_log_time ON auto_apply_log(created_at DESC);
