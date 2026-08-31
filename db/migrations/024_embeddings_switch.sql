-- ============================================================
-- Embedding is off until it is paid for
--
-- The embed tick runs every 60 seconds and every one of them now ends
-- in a 402 from OpenRouter. Nothing downstream breaks — embeddings are
-- computed but not yet read by anything — so the only cost is a log
-- line and a pointless request. But a background job that fails forever
-- is exactly the sort of noise that hides a real failure later.
--
-- Default false: this turns embedding OFF for the current install,
-- which is the honest default for a feature that costs money per ad and
-- has no consumer yet. Turning it on is a decision with a price tag
-- (~$0.0000125 per ad, so roughly $0.13 for the 10 554 ads still
-- unembedded), and the switch says so.
--
-- The vectors already computed are kept. They cost real money, they do
-- not expire, and re-embedding 17 077 ads to get back where we already
-- are would be the worst possible way to save nothing.
-- ============================================================
ALTER TABLE profile
  ADD COLUMN embeddings_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN profile.embeddings_enabled IS
  'Whether the worker may spend money embedding ads. False = the embed tick is skipped entirely; existing vectors are retained untouched.';
