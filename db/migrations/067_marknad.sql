-- ============================================================
-- The shared market: what the whole pool says about who is hiring.
--
-- 1. ads.raw keeps number_of_vacancies. An ad for twelve warehouse
--    workers is twelve openings, and "who is hiring the most" counted
--    in ads alone undercounts exactly the employers hiring the most.
--    Rows written before this have none; the daily snapshot rewrites
--    each open ad with it the next time it runs.
--
-- 2. marknad_dag: one row per day, occupation field and region, with
--    counts only. The pool forgets: a closed ad is deleted seven days
--    after it closes (src/refresh.js pruneStaleAds), so a trend over
--    months cannot be read back from ads — it has to be written down as
--    it happens. Nothing in it names an ad, an employer or a user.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ad_raw_slim(r jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE WHEN jsonb_typeof(r) IS DISTINCT FROM 'object' THEN r ELSE jsonb_strip_nulls(jsonb_build_object(
    'id', r->'id',
    'experience_required', r->'experience_required',
    'number_of_vacancies', r->'number_of_vacancies',
    'workplace_address', CASE WHEN jsonb_typeof(r->'workplace_address') = 'object' THEN jsonb_build_object(
      'municipality', r#>'{workplace_address,municipality}',
      'municipality_concept_id', r#>'{workplace_address,municipality_concept_id}',
      'region', r#>'{workplace_address,region}',
      'region_concept_id', r#>'{workplace_address,region_concept_id}',
      'city', r#>'{workplace_address,city}',
      'street_address', r#>'{workplace_address,street_address}',
      'postcode', r#>'{workplace_address,postcode}',
      'coordinates', r#>'{workplace_address,coordinates}') END,
    'occupation', public.ad_raw_begrepp(r->'occupation'),
    'occupation_group', public.ad_raw_begrepp(r->'occupation_group'),
    'occupation_field', public.ad_raw_begrepp(r->'occupation_field'),
    'employment_type', public.ad_raw_begrepp(r->'employment_type'),
    'working_hours_type', public.ad_raw_begrepp(r->'working_hours_type'),
    'employer', CASE WHEN r#>>'{employer,organization_number}' IS NOT NULL
      THEN jsonb_build_object('organization_number', r#>'{employer,organization_number}') END,
    'must_have', public.ad_raw_krav(r->'must_have'),
    'nice_to_have', public.ad_raw_krav(r->'nice_to_have'))) END
$$;

COMMENT ON FUNCTION public.ad_raw_slim(r jsonb) IS 'The paths of a JobTech ad the app reads; everything else is dropped. Idempotent. A new raw-> path in the code must be added here, or it reads null. number_of_vacancies since 067 (the market view counts openings, not only ads).';

CREATE TABLE IF NOT EXISTS public.marknad_dag (
  dag date NOT NULL,
  falt_id text NOT NULL,
  falt text NOT NULL,
  region_id text NOT NULL,
  region text NOT NULL,
  nya integer NOT NULL DEFAULT 0,
  platser integer NOT NULL DEFAULT 0,
  stangda integer NOT NULL DEFAULT 0,
  oppna integer NOT NULL DEFAULT 0,
  uppdaterad timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dag, falt_id, region_id)
);
ALTER TABLE public.marknad_dag ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.marknad_dag FROM anon, authenticated;
  END IF;
END
$$;

COMMENT ON TABLE public.marknad_dag IS
  'The shared market, one row per day x occupation field x region (src/marknad.js byggMarknad, run by the janitor). Counts only — no ad, employer or user is named. Kept because the pool forgets: closed ads are deleted seven days after closing, so trends have to be written down as they happen. The last seven days are recomputed each run; older days are final.';
COMMENT ON COLUMN public.marknad_dag.nya IS 'Ads published that day.';
COMMENT ON COLUMN public.marknad_dag.platser IS 'Openings in those new ads (number_of_vacancies, 1 where the ad gives none). Undercounted for ads written before migration 067.';
COMMENT ON COLUMN public.marknad_dag.stangda IS 'Ads withdrawn that day (removed_at) — taken down before or at their deadline, the nearest sign there is that a role was filled.';
COMMENT ON COLUMN public.marknad_dag.oppna IS 'Ads open at the end of the day: published by then, not withdrawn, deadline not passed.';
COMMENT ON COLUMN public.marknad_dag.falt_id IS 'The occupation field''s concept_id (Arbetsförmedlingen''s taxonomy), or ''okänt'' when the ad gives none. Matches on concept_id, never on labels (CLAUDE.md invariant 6).';
