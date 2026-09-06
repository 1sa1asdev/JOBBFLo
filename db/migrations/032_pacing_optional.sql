-- ============================================================
-- Pacing becomes a choice rather than a rule.
--
-- 030 paced every campaign because a rule change had once spent the
-- whole day's cap in three seconds. The gap is still the right default,
-- but it is the user's call: when a campaign is aimed at a pool that
-- goes stale in a day, ten letters every five minutes is a way of
-- arriving late, and the daily cap is already the ceiling that matters.
--
-- NULL means no batching: one run sends everything the day still
-- allows, up to auto_apply_daily_limit. The default stays 10, so an
-- existing campaign keeps pacing until it is turned off deliberately.
-- ============================================================
ALTER TABLE searches
  ALTER COLUMN send_batch_size DROP NOT NULL,
  ALTER COLUMN send_batch_minutes DROP NOT NULL;

COMMENT ON COLUMN searches.send_batch_size IS
  'Most letters one run may send, or NULL to send the day''s whole allowance at once. The daily limit is still the ceiling.';
