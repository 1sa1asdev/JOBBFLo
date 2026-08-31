-- ============================================================
-- More than one place per search
--
-- A campaign that should cover Linköping AND Stockholm could not say
-- so: `location` held one string and the PATCH wrote it to a single
-- api_filters.municipality value. Everything downstream was already
-- ready — resolveFilters concats arrays, buildQuery appends one
-- parameter per value, and JobSearch ORs repeated municipality
-- parameters exactly (Stockholm 6630 + Linköping 1120 = 7750 together,
-- measured). The column was the only thing in the way.
--
-- text[] rather than a comma-joined string: no Swedish municipality
-- contains a comma today, but choosing a delimiter that "probably
-- won't appear" is how that class of bug is born.
-- ============================================================
ALTER TABLE searches
  ALTER COLUMN location TYPE text[]
  USING (CASE WHEN location IS NULL OR btrim(location) = ''
              THEN NULL ELSE ARRAY[btrim(location)] END);

COMMENT ON COLUMN searches.location IS
  'Places the user picked explicitly, municipalities and/or län. Each is routed to api_filters.municipality or .region by taxonomy type; JobSearch ORs them.';
