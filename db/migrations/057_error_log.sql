-- ============================================================
-- Errors nobody caught, in the app and in the worker, where the
-- operator can see them (/admin) without a paid monitoring service.
-- Kept 30 days. The message is the error's own, cut to 300 characters;
-- no request bodies, no user ids.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.error_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  källa text NOT NULL,
  väg text,
  metod text,
  meddelande text NOT NULL,
  digest text
);
CREATE INDEX IF NOT EXISTS error_log_at ON public.error_log (at DESC);
ALTER TABLE public.error_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.error_log IS
  'Uncaught errors: app requests (instrumentation.js onRequestError) and the worker/janitor (process handlers). Shown on /admin, deleted after 30 days. No bodies, no user ids — the path and the message only.';
