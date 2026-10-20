-- ============================================================
-- "Never apply" is one user's decision.
--
-- never_apply was keyed on the fingerprint alone, so one user hiding an
-- ad hid it — and every repost of it — from every user's searches. It is
-- now (profile, fingerprint): still keyed on the fingerprint, so a
-- repost with a fresh external_id stays hidden, but only for whoever
-- hid it.
-- ============================================================
ALTER TABLE public.never_apply
  ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES public.profile(id) ON DELETE CASCADE;

-- Everything hidden so far was hidden by the one profile there was. A
-- row that cannot be attributed (only possible with several profiles
-- and no owner recorded) hides nothing correctly, so it goes.
UPDATE public.never_apply SET profile_id = (SELECT id FROM public.profile ORDER BY created_at LIMIT 1)
WHERE profile_id IS NULL AND (SELECT count(*) FROM public.profile) = 1;
DELETE FROM public.never_apply WHERE profile_id IS NULL;

ALTER TABLE public.never_apply ALTER COLUMN profile_id SET NOT NULL;
ALTER TABLE public.never_apply DROP CONSTRAINT never_apply_pkey;
ALTER TABLE public.never_apply ADD CONSTRAINT never_apply_pkey PRIMARY KEY (profile_id, fingerprint);

COMMENT ON TABLE public.never_apply IS
  'One user''s "never apply". Keyed on (profile, FINGERPRINT), not ad_id, so a repost with a fresh external_id stays hidden — for that user only.';

-- The "suppressed" flag in a search's results is its owner's decision.
CREATE OR REPLACE VIEW public.search_results AS
 SELECT m.search_id,
    a.id AS ad_id,
    a.title,
    a.employer,
    a.municipality,
    a.deadline,
    a.ats_vendor,
    m.score,
    m.summary,
    m.flags,
    (m.score IS NULL) AS pending,
    (m.shortlisted_at IS NOT NULL) AS shortlisted,
    m.shortlisted_at,
    (m.score_requested_at IS NOT NULL) AS score_requested,
    m.score_requested_at,
    m.queued_at,
    m.attempts,
    m.last_error,
    app.status AS application_status,
    app.sent_at,
    app.origin_search_id,
    ((app.id IS NOT NULL) AND (m.search_id <> app.origin_search_id)) AS applied_via_other_search,
    (na.fingerprint IS NOT NULL) AS suppressed
   FROM public.match_results m
     JOIN public.searches s ON s.id = m.search_id
     JOIN public.ads a ON a.id = m.ad_id
     LEFT JOIN public.applications app ON app.ad_id = a.id AND app.profile_id = s.profile_id
     LEFT JOIN public.never_apply na ON na.fingerprint = a.fingerprint AND na.profile_id = s.profile_id
  WHERE a.removed_at IS NULL;

COMMENT ON VIEW public.search_results IS
  'The query that fixes the predecessor''s bug: application status is a JOIN, not a sync. Same ad in two searches: two scores, one status. Application and "suppressed" are the search owner''s own.';
