-- ============================================================
-- ads.raw keeps what the app reads, not the whole API response.
--
-- raw was the full JobTech ad, saved "in case". It was the largest
-- thing in the database (211 MB of 663 MB locally) and most of it was
-- the description twice more: description.text — the same text as
-- ads.description — and description.text_formatted, HTML no code read.
-- The free Supabase plan holds 500 MB; production was over it, and the
-- disk throughput this cost is what took it down on 21 Oct.
--
-- What stays is every path something reads (src/localsearch.js, the
-- results and home routes, adprofile, prefilter, autoapply, the lat/lon
-- columns, postcode_coords and the filter indexes):
--   workplace_address   municipality, region (names + concept ids),
--                       city, street_address, postcode, coordinates
--   occupation, occupation_group, occupation_field,
--   employment_type, working_hours_type     concept_id + label
--   experience_required, employer.organization_number, id
--   must_have / nice_to_have                the API's skill lists,
--                       concept_id + label + weight: unread today, small,
--                       and the obvious input for grading later
--
-- A trigger slims every write, so it holds whoever writes: the worker,
-- the snapshot, or code from before this migration still running while
-- a deploy rolls out. EXCLUDED in an upsert sees the slimmed value, so
-- "has this ad changed" compares slim with slim.
--
-- Only platsbanken ads: a pasted ad's raw is what the user pasted.
-- ============================================================

SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = 0;

-- A taxonomy concept: its id, which filters match on, and its label,
-- which people read.
CREATE FUNCTION public.ad_raw_begrepp(c jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(c) = 'object'
    THEN jsonb_build_object('concept_id', c->'concept_id', 'label', c->'label') END
$$;

-- A list of concepts with their weight, in the API's order; nothing
-- when empty.
CREATE FUNCTION public.ad_raw_lista(l jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(l) = 'array' AND jsonb_array_length(l) > 0 THEN
    (SELECT jsonb_agg(jsonb_build_object(
              'concept_id', e->'concept_id', 'label', e->'label', 'weight', e->'weight') ORDER BY i)
     FROM jsonb_array_elements(l) WITH ORDINALITY AS t(e, i)) END
$$;

-- must_have / nice_to_have.
CREATE FUNCTION public.ad_raw_krav(k jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(k) = 'object' THEN NULLIF(jsonb_strip_nulls(jsonb_build_object(
    'skills', public.ad_raw_lista(k->'skills'),
    'languages', public.ad_raw_lista(k->'languages'),
    'work_experiences', public.ad_raw_lista(k->'work_experiences'),
    'education', public.ad_raw_lista(k->'education'),
    'education_level', public.ad_raw_lista(k->'education_level'))), '{}'::jsonb) END
$$;

-- The whole ad. Idempotent: slimming a slim ad changes nothing.
CREATE FUNCTION public.ad_raw_slim(r jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(r) IS DISTINCT FROM 'object' THEN r ELSE jsonb_strip_nulls(jsonb_build_object(
    'id', r->'id',
    'experience_required', r->'experience_required',
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

CREATE FUNCTION public.ads_slim_raw() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'platsbanken' THEN
    NEW.raw := public.ad_raw_slim(NEW.raw);
  END IF;
  RETURN NEW;
END
$$;

-- Pure functions over their argument, but the Data API can call any
-- function PUBLIC may execute; nothing outside the server needs these.
REVOKE ALL ON FUNCTION public.ad_raw_begrepp(jsonb), public.ad_raw_lista(jsonb),
  public.ad_raw_krav(jsonb), public.ad_raw_slim(jsonb), public.ads_slim_raw() FROM PUBLIC;

-- The rewrite. lat/lon are generated from raw and postcode_coords reads
-- it, and Postgres will not change a column under either, so they go
-- and come back in the same statement: one rewrite of the table, which
-- is also what hands the space back (an UPDATE would leave the file as
-- large as before).
DROP VIEW public.postcode_coords;
ALTER TABLE public.ads
  DROP COLUMN lat,
  DROP COLUMN lon,
  ALTER COLUMN raw TYPE jsonb
    USING (CASE WHEN source = 'platsbanken' THEN public.ad_raw_slim(raw) ELSE raw END),
  ADD COLUMN lon double precision
    GENERATED ALWAYS AS (((raw -> 'workplace_address' -> 'coordinates') ->> 0)::double precision) STORED,
  ADD COLUMN lat double precision
    GENERATED ALWAYS AS (((raw -> 'workplace_address' -> 'coordinates') ->> 1)::double precision) STORED;

CREATE INDEX ads_latlon ON public.ads USING btree (lat, lon) WHERE (lat IS NOT NULL);

CREATE VIEW public.postcode_coords WITH (security_invoker = true) AS
  SELECT replace(raw -> 'workplace_address' ->> 'postcode', ' ', '') AS postcode,
         avg(lat) AS lat,
         avg(lon) AS lon,
         count(*) AS ads
  FROM public.ads
  WHERE lat IS NOT NULL AND (raw -> 'workplace_address' ->> 'postcode') IS NOT NULL
  GROUP BY replace(raw -> 'workplace_address' ->> 'postcode', ' ', '');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.postcode_coords FROM anon, authenticated;
  END IF;
END
$$;

CREATE TRIGGER ads_slim_raw BEFORE INSERT OR UPDATE OF raw, source ON public.ads
  FOR EACH ROW EXECUTE FUNCTION public.ads_slim_raw();

COMMENT ON COLUMN public.ads.raw IS
  'What the app reads from the JobTech ad, not the whole response (migration 062, public.ad_raw_slim): workplace_address, the occupation and employment concepts, experience_required, employer.organization_number and the skill lists. The description lives once, in ads.description. Slimmed by the ads_slim_raw trigger on every write.';
COMMENT ON COLUMN public.ads.lat IS
  'Workplace latitude, derived from raw. AF orders coordinates [lon, lat] — index 1 is lat.';
COMMENT ON FUNCTION public.ad_raw_slim(jsonb) IS
  'The paths of a JobTech ad the app reads; everything else is dropped. Idempotent. A new raw-> path in the code must be added here, or it reads null.';
