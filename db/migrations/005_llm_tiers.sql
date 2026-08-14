-- ============================================================
-- 005: split the "smart" tier into bulk (scoring) and write (prose).
--
-- Scoring is ~90% of tokens; letters are ~10% but are what the user
-- actually reads. Paying premium rates for scoring costs ~8x more
-- than paying them for prose, so the two need separate models.
-- Both fall back to llm_model_smart, so existing rows keep working.
-- ============================================================
ALTER TABLE profile ADD COLUMN IF NOT EXISTS llm_model_bulk text;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS llm_model_write text;
