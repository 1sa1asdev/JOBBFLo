-- ============================================================
-- Login moves to Supabase Auth (Google), and the database is locked to
-- the server.
--
-- Accounts: a Supabase user is linked to our users row by auth_id. The
-- password hash stays for the local password mode (CI, development) and
-- is NULL for Google accounts. role marks the operator.
--
-- RLS: Supabase publishes every table in public through its Data API,
-- and the anon key that reaches it ships to every browser. Measured on
-- a local Supabase before this migration: GET /rest/v1/profile with the
-- anon key returned a stranger's CV. The app never uses the Data API —
-- the server talks to Postgres directly as the tables' owner, which RLS
-- does not restrict — so every table gets RLS with no policies (nobody
-- else reads anything), and the Data API roles lose their grants.
-- ============================================================

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS auth_id uuid UNIQUE;
ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));

COMMENT ON COLUMN public.users.auth_id IS
  'The Supabase Auth user (auth.users.id) this account signs in as. NULL for local password accounts.';
COMMENT ON COLUMN public.users.password_hash IS
  'scrypt hash, local password mode only (CI and development). NULL for Google accounts.';
COMMENT ON COLUMN public.users.role IS
  'admin: the operator — the admin pages, platform settings and every user''s usage. Set by hand: node scripts/make-admin.js <email>.';

-- Google's refresh token, captured at sign-in while Supabase still hands
-- it over (it does not store or refresh provider tokens). For the Gmail
-- API later; encrypted like the app password.
ALTER TABLE public.profile ADD COLUMN IF NOT EXISTS google_refresh_token_enc text;
COMMENT ON COLUMN public.profile.google_refresh_token_enc IS
  'Google OAuth refresh token from sign-in, encrypted (src/secrets.js). Unused until Gmail access over OAuth is approved.';

-- Every table in public, now and — through scripts/prove-rls.js in CI —
-- every one a later migration adds.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;

-- A view runs as its owner and would read past RLS for whoever may
-- query it; as invoker, it is held to the caller's rights.
ALTER VIEW public.search_results SET (security_invoker = true);
ALTER VIEW public.postcode_coords SET (security_invoker = true);

-- The Data API's roles exist only on Supabase. There they lose every
-- grant on public, now and for objects created later.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END $$;
