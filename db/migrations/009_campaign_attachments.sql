-- ============================================================
-- 009: attachments can belong to one campaign.
--
-- attachments was profile-wide ("always send my betyg"). A campaign
-- often wants its own set — a portfolio for dev roles, references
-- for service roles — without those following every other send.
-- search_id NULL keeps the old meaning: attach to everything.
-- ============================================================
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS search_id uuid
  REFERENCES searches(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS attachments_search ON attachments(search_id);
