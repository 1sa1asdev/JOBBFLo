-- ============================================================
-- An ad a user adds by hand is theirs, not the pool's.
--
-- autoapply/lead and /lead/bulk wrote manual ads into the shared pool,
-- and the pool is what every search reads — so user A's ad, with an
-- address A typed in, could be matched by user B's campaign, and B's CV
-- sent to A's address. The ads that come from the feed and the snapshot
-- stay shared (owner NULL); a manual one belongs to the user who made
-- it, and only their searches see it.
--
-- ON DELETE CASCADE: a manual ad has no life beyond its owner. It never
-- entered anyone else's searches, so nothing else refers to it.
-- ============================================================
ALTER TABLE public.ads
  ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profile(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ads_owner ON public.ads (owner_profile_id) WHERE owner_profile_id IS NOT NULL;

COMMENT ON COLUMN public.ads.owner_profile_id IS
  'NULL for the shared pool (JobStream and the snapshot). Set for an ad a user added by hand: only that user''s searches see it, and other users get a 404 on it.';

-- Manual ads made before this belong to the one profile there was.
UPDATE public.ads SET owner_profile_id = (SELECT id FROM public.profile ORDER BY created_at LIMIT 1)
WHERE source = 'manual' AND owner_profile_id IS NULL AND (SELECT count(*) FROM public.profile) = 1;
