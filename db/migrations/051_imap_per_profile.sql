-- ============================================================
-- The mail loop is one instance per user, and so is its state.
--
-- imap_state had one row per mailbox name for the whole app, and the
-- "Hämta post" button signalled through one shared poll_state row. With
-- two users their read positions would overwrite each other, and one
-- user's button would fetch someone else's mailbox. Nothing about a
-- user's mail is shared now: read position, button signal and failure
-- state are all per profile.
-- ============================================================

-- Read position: (user, mailbox). The one profile there is keeps its own.
ALTER TABLE public.imap_state
  ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES public.profile(id) ON DELETE CASCADE;
UPDATE public.imap_state SET profile_id = (SELECT id FROM public.profile ORDER BY created_at LIMIT 1)
WHERE profile_id IS NULL AND (SELECT count(*) FROM public.profile) = 1;
-- A position nobody can be credited with is a position nobody should
-- resume from: that user's loop starts from their first letter instead.
DELETE FROM public.imap_state WHERE profile_id IS NULL;
ALTER TABLE public.imap_state ALTER COLUMN profile_id SET NOT NULL;
ALTER TABLE public.imap_state DROP CONSTRAINT imap_state_pkey;
ALTER TABLE public.imap_state ADD CONSTRAINT imap_state_pkey PRIMARY KEY (profile_id, mailbox);

COMMENT ON TABLE public.imap_state IS
  'Where one user''s mail loop has read up to, per mailbox. Starts at the user''s first letter sent through the app — nothing older is read.';

-- "Hämta post": one row per user, answered by that user's mailbox only.
CREATE TABLE IF NOT EXISTS public.imap_sync_requests (
  profile_id   uuid PRIMARY KEY REFERENCES public.profile(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  outcome      text
);

COMMENT ON TABLE public.imap_sync_requests IS
  'A user pressed "Hämta post". The worker''s mailbox for that user answers it on its open connection and stamps done_at; no other user''s mailbox is touched.';
COMMENT ON COLUMN public.imap_sync_requests.outcome IS
  'klar, ingen brevlåda (the worker has none for this user — the route then reads directly) or the error. Lets the route stop waiting at once instead of timing out.';

DELETE FROM public.poll_state WHERE key = 'imap_sync_request';

-- Why a user's mail stopped being read. Set when Gmail keeps refusing
-- the stored app password (revoked, or the Google password changed):
-- the loop stops instead of retrying until Google locks the account,
-- and the settings page says what happened.
ALTER TABLE public.profile ADD COLUMN IF NOT EXISTS gmail_error text;
ALTER TABLE public.profile ADD COLUMN IF NOT EXISTS gmail_error_at timestamptz;

COMMENT ON COLUMN public.profile.gmail_error IS
  'Last reason Gmail refused this user''s app password, after which their mail loop stopped. Cleared when a new password is saved.';
