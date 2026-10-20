-- ============================================================
-- What the operator decides, and the operator's one sanction.
--
-- Embedding the ad pool is the platform's cost, yet the switch for it
-- lived on a profile — and the worker read it as
-- "SELECT embeddings_enabled FROM profile LIMIT 1", whichever profile
-- came first. It is a platform setting now, changed on the admin page.
--
-- users.disabled_at: a blocked account cannot sign in, its campaigns are
-- paused with the reason, and the worker closes its mailbox.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.platform_settings IS
  'Settings that belong to the platform, not to any user: changed on the admin page (src/platform.js). embeddings_enabled: whether the worker embeds new ads and rebuilds query vectors — the operator''s spend.';

-- The switch keeps the value it had: the one profile's, or on.
INSERT INTO public.platform_settings (key, value)
SELECT 'embeddings_enabled',
       to_jsonb(COALESCE((SELECT bool_or(embeddings_enabled) FROM public.profile), true))
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.profile DROP COLUMN IF EXISTS embeddings_enabled;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
COMMENT ON COLUMN public.users.disabled_at IS
  'Blocked by the operator. Sign-in is refused (403), campaigns are paused with the reason, the mailbox closes. Cleared to let them back in; campaigns stay paused for the user to restart.';
