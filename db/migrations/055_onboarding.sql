-- ============================================================
-- The first-run guide: Gmail app password, AI models with what they
-- will cost, and the CV. A new account is sent to /valkommen until it
-- has been through it once (skipping steps is allowed — the guide is a
-- way in, not a gate on any feature).
-- ============================================================
ALTER TABLE public.profile ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;

COMMENT ON COLUMN public.profile.onboarded_at IS
  'When the user finished (or skipped through) the first-run guide at /valkommen. NULL sends them there from the start page.';

-- Profiles already set up have nothing to be guided through.
UPDATE public.profile SET onboarded_at = now()
WHERE onboarded_at IS NULL
  AND (cv_text IS NOT NULL OR llm_provider IS NOT NULL OR gmail_app_password_enc IS NOT NULL);
