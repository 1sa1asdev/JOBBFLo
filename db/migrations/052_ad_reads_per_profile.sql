-- ============================================================
-- Reading an ad's requirements is each user's own.
--
-- ads.ad_profile was one read per ad for the whole app: whoever graded
-- an ad first paid for the read, with their model, and every other user
-- got it. A user's choice of model then decided nothing for anyone else,
-- and another user's read decided their checklist. Reads now belong to
-- the user who made them, and so does the checklist built on one.
--
-- The vector made from the read (profile_embedding) goes too. The
-- platform paid to embed one user's read, and nothing ranked on it —
-- both places that could use it say in the code that they do not.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ad_reads (
  ad_id      uuid NOT NULL REFERENCES public.ads(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profile(id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('ok', 'misslyckad', 'tom')),
  model      text,
  profile    jsonb,
  reason     text,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ad_id, profile_id)
);

COMMENT ON TABLE public.ad_reads IS
  'One user''s read of one ad''s requirements (src/adprofile.js), made on that user''s key with their model and never shown to anyone else. Keyed without the model on purpose: a read that passed the thin-read gate stays good when the user changes model, and "Försök igen" reads again with the current one.';
COMMENT ON COLUMN public.ad_reads.status IS
  'ok: graded on. misslyckad: even the better model''s read was too thin to trust, so nothing was graded and the queue does not pay to read it again — "Försök igen" does. tom: the ad has no text to read; nothing was paid.';
COMMENT ON COLUMN public.ad_reads.reason IS
  'Why a read failed, in words the user reads on the card.';

-- The reads that exist were all made by the one user there has been.
INSERT INTO public.ad_reads (ad_id, profile_id, status, model, profile, read_at)
SELECT a.id, (SELECT id FROM public.profile ORDER BY created_at LIMIT 1),
       CASE WHEN a.ad_profile_model = 'tunn' THEN 'tom' ELSE 'ok' END,
       NULLIF(a.ad_profile_model, 'tunn'), a.ad_profile, COALESCE(a.ad_profile_at, now())
FROM public.ads a
WHERE a.ad_profile IS NOT NULL AND (SELECT count(*) FROM public.profile) = 1
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- The checklist cache gets its owner. Keyed only on (ad, CV), two users
-- with the same CV text shared one — built on one of their reads.
-- ------------------------------------------------------------
ALTER TABLE public.ad_checks ADD COLUMN IF NOT EXISTS profile_id uuid
  REFERENCES public.profile(id) ON DELETE CASCADE;

-- Credited to the user whose search holds that verdict, else the only
-- profile. One that belongs to nobody is a cache entry nobody can reach.
UPDATE public.ad_checks c SET profile_id = s.profile_id
FROM public.match_results m JOIN public.searches s ON s.id = m.search_id
WHERE c.profile_id IS NULL AND m.ad_id = c.ad_id AND m.check_cv_key = c.cv_key;
UPDATE public.ad_checks SET profile_id = (SELECT id FROM public.profile ORDER BY created_at LIMIT 1)
WHERE profile_id IS NULL AND (SELECT count(*) FROM public.profile) = 1;
DELETE FROM public.ad_checks WHERE profile_id IS NULL;

ALTER TABLE public.ad_checks ALTER COLUMN profile_id SET NOT NULL;
ALTER TABLE public.ad_checks DROP CONSTRAINT ad_checks_pkey;
ALTER TABLE public.ad_checks ADD CONSTRAINT ad_checks_pkey PRIMARY KEY (ad_id, profile_id, cv_key);

COMMENT ON COLUMN public.ad_checks.profile_id IS
  'Whose checklist. Built from that user''s own read of the ad (ad_reads) and their CV; never reused for another user, even one with the same CV text.';

-- ------------------------------------------------------------
-- What the shared ad row no longer carries.
-- ------------------------------------------------------------
ALTER TABLE public.ads DROP COLUMN IF EXISTS ad_profile;
ALTER TABLE public.ads DROP COLUMN IF EXISTS ad_profile_at;
ALTER TABLE public.ads DROP COLUMN IF EXISTS ad_profile_model;
ALTER TABLE public.ads DROP COLUMN IF EXISTS profile_embedding;
ALTER TABLE public.ads DROP COLUMN IF EXISTS profile_embedded_at;
