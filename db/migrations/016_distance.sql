-- ============================================================
-- Distance to the workplace, computed — no model involved.
--
-- Arbetsförmedlingen puts lon/lat on every ad (6752 of 6752 in the
-- current pool), and the app was throwing it away. The list showed
-- "Stockholm" for a restaurangbiträde job in HAWAII, 6782 km out,
-- because municipality is all it ever displayed.
--
-- This is arithmetic, not inference: haversine over two coordinate
-- pairs. It needs no API key, no tile server, and no LLM.
--
-- Generated columns rather than a backfill + trigger: the coordinates
-- already live in `raw`, so deriving them keeps one source of truth and
-- means upsertAd needs no change to stay correct.
-- ============================================================

ALTER TABLE ads
  ADD COLUMN lon double precision
    GENERATED ALWAYS AS ((raw->'workplace_address'->'coordinates'->>0)::double precision) STORED,
  ADD COLUMN lat double precision
    GENERATED ALWAYS AS ((raw->'workplace_address'->'coordinates'->>1)::double precision) STORED;

COMMENT ON COLUMN ads.lat IS
  'Workplace latitude, derived from raw. AF orders coordinates [lon, lat] — index 1 is lat.';

-- Sorting and filtering by distance touches every candidate in a
-- search, so the pair needs to be cheap to reach.
CREATE INDEX ads_latlon ON ads (lat, lon) WHERE lat IS NOT NULL;

-- ------------------------------------------------------------
-- Where the user actually travels from. Stored as coordinates, with
-- the label kept for display so the UI can show "Södermalm, 118 26"
-- rather than a decimal pair.
-- ------------------------------------------------------------
ALTER TABLE profile
  ADD COLUMN home_lat   double precision,
  ADD COLUMN home_lon   double precision,
  ADD COLUMN home_label text;

COMMENT ON COLUMN profile.home_label IS
  'What the user typed (postcode or place). Resolved to coordinates against ads.raw, so no external geocoder is involved.';

-- ------------------------------------------------------------
-- Postcode -> coordinate, built from the ad pool itself. 2305 distinct
-- Swedish postcodes are already present with coordinates, which is
-- enough to place a home address without calling a geocoding service.
-- A view, not a table: it follows the pool as it grows.
-- ------------------------------------------------------------
CREATE VIEW postcode_coords AS
SELECT replace(raw->'workplace_address'->>'postcode', ' ', '') AS postcode,
       avg(lat) AS lat,
       avg(lon) AS lon,
       count(*) AS ads
FROM ads
WHERE lat IS NOT NULL AND raw->'workplace_address'->>'postcode' IS NOT NULL
GROUP BY 1;
