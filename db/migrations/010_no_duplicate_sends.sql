-- ============================================================
-- 010: make duplicate auto-sends impossible at the DB level.
--
-- Code-level checks can be defeated by a race (two worker ticks
-- overlapping, or a UI trigger during a tick). A unique index is
-- the only guarantee that survives that, so the rule is enforced
-- where it cannot be raced:
--
--   an address may receive AT MOST ONE auto-sent application, ever.
--
-- Cold email has no legitimate "send it again" case — if you ever
-- genuinely need to re-contact someone, that is a manual send,
-- which this deliberately still allows.
-- ============================================================

-- clean any pre-existing duplicates first (there should be none)
DELETE FROM applications a USING applications b
WHERE a.sent_by = 'auto' AND b.sent_by = 'auto'
  AND a.profile_id = b.profile_id
  AND lower(a.sent_to) = lower(b.sent_to)
  AND a.sent_to IS NOT NULL
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS applications_auto_one_per_address
  ON applications (profile_id, lower(sent_to))
  WHERE sent_by = 'auto' AND sent_to IS NOT NULL;
