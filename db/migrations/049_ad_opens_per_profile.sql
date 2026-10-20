-- ============================================================
-- "I opened the application link" is one user's fact.
--
-- It lived on the shared ad (ads.apply_url_opened_at), so one user
-- opening an ad's link marked it as opened — "✓ Sökt"-adjacent in the
-- results list — for everyone. Now one row per (user, ad).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ad_opens (
  profile_id uuid NOT NULL REFERENCES public.profile(id) ON DELETE CASCADE,
  ad_id      uuid NOT NULL REFERENCES public.ads(id) ON DELETE CASCADE,
  opened_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, ad_id)
);

COMMENT ON TABLE public.ad_opens IS
  'When a user last opened an ad''s application link from inside the app. Per user: it used to sit on the shared ad, where one user''s click showed for everyone.';

-- The opens recorded so far were the one profile's.
INSERT INTO public.ad_opens (profile_id, ad_id, opened_at)
SELECT (SELECT id FROM public.profile ORDER BY created_at LIMIT 1), a.id, a.apply_url_opened_at
FROM public.ads a
WHERE a.apply_url_opened_at IS NOT NULL AND (SELECT count(*) FROM public.profile) = 1
ON CONFLICT DO NOTHING;

ALTER TABLE public.ads DROP COLUMN IF EXISTS apply_url_opened_at;
