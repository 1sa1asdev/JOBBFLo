-- ============================================================
-- 002: bring-your-own-API-key. Each profile picks its own LLM
-- provider and stores its own key (encrypted at rest).
-- Falls back to server env vars when unset.
-- ============================================================

ALTER TABLE profile ADD COLUMN IF NOT EXISTS llm_provider text;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS llm_api_key_enc text;   -- aes-256-gcm
ALTER TABLE profile ADD COLUMN IF NOT EXISTS llm_model_smart text;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS llm_model_fast text;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS llm_base_url text;      -- for 'custom'/self-hosted
