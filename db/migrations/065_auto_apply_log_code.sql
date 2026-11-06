-- ============================================================
-- A code on every campaign log row that failed, from src/felkoder.js.
--
-- The detail column holds the raw error, which is for people. What the
-- campaign does next has to be decided by something stable: whether to
-- try again, when to pause, and whether a failed letter's draft may be
-- released so its ad can be tried again (only when Gmail cannot have
-- taken the letter). Matching message text for that is what let
-- "Connection timeout" pause a campaign on 5 Nov.
--
-- Nullable: rows written before this have none, and code without a
-- failure (a sent letter, an ordinary skip) has nothing to say.
-- ============================================================
ALTER TABLE public.auto_apply_log ADD COLUMN IF NOT EXISTS code text;

COMMENT ON COLUMN public.auto_apply_log.code IS
  'Why a send failed, as a code from src/felkoder.js (MAIL_CONNECT_FAILED, MAIL_LOGIN_REJECTED, ...). Decides retry vs pause, the five-in-a-row pause, and whether the draft may be released (only codes that fail before Gmail could take the letter). NULL for rows that are not a failed send, and for rows from before migration 065.';
