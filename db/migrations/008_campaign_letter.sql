-- ============================================================
-- 008: campaigns get ONE co-authored letter, not N generated ones.
--
-- The earlier design generated a fresh letter per ad, which meant
-- nothing that went out had ever been read by the user. A campaign
-- now works like a search: you tell the AI the rules, then you and
-- the AI write ONE letter together, and that letter is what every
-- matching employer receives.
--
-- Light personalisation only, via placeholders the engine fills:
--   {{tjänst}} {{arbetsgivare}} {{ort}}
-- so the letter reads as addressed rather than bulk, while still
-- being the exact text the user approved.
-- ============================================================

ALTER TABLE searches ADD COLUMN IF NOT EXISTS campaign_subject text;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS campaign_letter text;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS campaign_letter_approved_at timestamptz;

CREATE TABLE IF NOT EXISTS campaign_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id  uuid NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user','assistant')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_messages_search ON campaign_messages(search_id, created_at);
