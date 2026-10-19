-- ============================================================
-- Whose model call it was.
--
-- llm_usage recorded every call but not whose it was, so the budget
-- under Profil summed everyone's spend, and with more than one user a
-- monthly cap would be measured against a total nobody owns. Every
-- call now carries profileId (src/llm.js), runs on that user's key, and
-- is written down against them here.
--
-- ON DELETE SET NULL rather than CASCADE: a deleted user's calls still
-- happened and still cost what they cost. Kept anonymous, they keep the
-- per-task averages honest — those averages (prices.js unitCosts) are
-- what the onboarding cost estimate is built on.
-- ============================================================
ALTER TABLE public.llm_usage
  ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES public.profile(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS llm_usage_profile_at ON public.llm_usage (profile_id, at DESC);

COMMENT ON COLUMN public.llm_usage.profile_id IS
  'The user whose key paid for this call. NULL for calls recorded before per-user keys, and for users since deleted.';

-- Everything recorded so far was made with the one profile there was.
UPDATE public.llm_usage SET profile_id = (SELECT id FROM public.profile ORDER BY created_at LIMIT 1)
WHERE profile_id IS NULL AND (SELECT count(*) FROM public.profile) = 1;
