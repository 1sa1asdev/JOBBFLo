-- ============================================================
-- Whether a letter's claims survive a look at the CV.
--
-- A letter written by a model, sent by a campaign, to a stranger, with
-- nobody reading it in between. The first three were already true; the
-- fourth arrived when the address confirmation step was dropped. So the
-- last reader of a cover letter before the employer is now nobody, and
-- "jag har fem års erfarenhet av Kubernetes" reaches them either way.
--
-- Stored per letter VERSION: a revision invalidates the result, and a
-- stale pass is worse than no pass because it reads as cleared.
-- ============================================================
ALTER TABLE applications
  ADD COLUMN claim_check jsonb,
  ADD COLUMN claim_checked_version int;

COMMENT ON COLUMN applications.claim_check IS
  'Result of checkClaims(): the letter''s unsupported or contradicted claims, each quoted verbatim from the letter.';
COMMENT ON COLUMN applications.claim_checked_version IS
  'letter_version this check ran against. Differs from letter_version = the check is stale.';
