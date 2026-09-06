-- ============================================================
-- Letters leave in small batches, not in a burst.
--
-- Lowering a threshold once sent seventeen letters in three seconds,
-- because the rule changed and the campaign immediately spent everything
-- the daily cap allowed. Nothing was wrong with any single decision; the
-- problem was that they all happened at once, with no interval in which
-- a person could notice and stop it.
--
-- Three reasons to pace it. A burst from one Gmail account looks like
-- exactly what it is. A mistake in a rule costs ten letters instead of a
-- hundred. And the gap is the only thing that makes "stäng av kampanjen"
-- a real option rather than a button pressed after the fact.
-- ============================================================
ALTER TABLE searches
  ADD COLUMN send_batch_size int NOT NULL DEFAULT 10
    CHECK (send_batch_size BETWEEN 1 AND 50),
  ADD COLUMN send_batch_minutes int NOT NULL DEFAULT 5
    CHECK (send_batch_minutes BETWEEN 1 AND 240),
  ADD COLUMN last_batch_at timestamptz;

COMMENT ON COLUMN searches.send_batch_size IS
  'Most letters one run may send. The daily limit is the ceiling; this is the burst.';
COMMENT ON COLUMN searches.send_batch_minutes IS
  'Quiet period between scheduled batches. A manual run ignores it — the user is standing there — but is still limited to one batch.';
