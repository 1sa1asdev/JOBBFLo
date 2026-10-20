-- ============================================================
-- An address a user types in is theirs, not the ad's.
--
-- "Hitta adresser" saved every address on the shared ad — the one row
-- every user's campaign reads. So an address one user typed in (wrong,
-- or deliberately someone else's) became where other users' CVs and
-- letters went, with nothing telling them it came from a stranger and
-- not from the employer. The route even took the client's word for
-- whether an address had been "scanned".
--
-- Two kinds of address now:
--   ads.apply_email   the employer's: published by Arbetsförmedlingen,
--                     or read by the server itself off the employer's
--                     application page (lead_scans). Shared.
--   ad_contacts       typed in by a user. Theirs alone; their campaigns
--                     use it ahead of the shared one, nobody else sees it.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ad_contacts (
  profile_id uuid NOT NULL REFERENCES public.profile(id) ON DELETE CASCADE,
  ad_id      uuid NOT NULL REFERENCES public.ads(id) ON DELETE CASCADE,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, ad_id)
);

COMMENT ON TABLE public.ad_contacts IS
  'An application address a user typed in for an ad. Used by that user''s campaigns ahead of ads.apply_email, and by nobody else''s — an address only becomes shared (ads.apply_email) when the employer published it or the server read it off the employer''s own page.';

-- What is already shared but was not read by the server: typed in by
-- hand on a pool ad, or marked "scanned" by the client with no scan of
-- the server's behind it. It moves to the one profile there is, and
-- leaves the shared ad. (On an install with several profiles nobody can
-- be credited with it, so it only leaves the shared ad.)
WITH ej_serverns AS (
  SELECT a.id, a.apply_email FROM public.ads a
  WHERE a.owner_profile_id IS NULL AND a.apply_email IS NOT NULL
    AND (a.apply_email_source = 'manual'
         OR (a.apply_email_source = 'scanned' AND NOT EXISTS (
               SELECT 1 FROM public.lead_scans ls, jsonb_array_elements(ls.contacts) c
               WHERE ls.ad_id = a.id AND lower(c->>'email') = lower(a.apply_email))))
), flyttade AS (
  INSERT INTO public.ad_contacts (profile_id, ad_id, email)
  SELECT (SELECT id FROM public.profile ORDER BY created_at LIMIT 1), e.id, e.apply_email
  FROM ej_serverns e
  WHERE (SELECT count(*) FROM public.profile) = 1
  ON CONFLICT DO NOTHING
)
UPDATE public.ads a SET apply_email = NULL, apply_email_source = NULL
FROM ej_serverns e WHERE a.id = e.id;
