-- ============================================================
-- Counters for the routes someone could hammer (src/takt.js).
--
-- In Postgres because the app runs as many Vercel instances that share
-- nothing else; a counter in memory would be per instance and mean
-- nothing. One row per (key, window); old windows are swept as new ones
-- are written.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.rate_limits (
  nyckel text NOT NULL,
  fönster timestamptz NOT NULL,
  antal integer NOT NULL DEFAULT 1,
  PRIMARY KEY (nyckel, fönster)
);
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.rate_limits IS
  'Fixed-window request counts per key — "login:<ip>", "sync:<profile>". A key holds no more than an IP address or a profile id, and a window older than a day is deleted.';
