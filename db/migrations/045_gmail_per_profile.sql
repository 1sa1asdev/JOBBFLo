-- ============================================================
-- Gmail credentials belong to the user, not to the server.
--
-- The app password lived in .env as GMAIL_APP_PASSWORD, read by
-- src/mailer.js and src/imap.js — which works for one person on one
-- machine and for nobody else. Every user now enters their own after
-- signing up; it is stored here, encrypted with the platform's key
-- (src/secrets.js), and read only for that user's mail.
--
-- The address is profile.email: the sender is always the user
-- themselves, the account they sign in with.
-- ============================================================
ALTER TABLE public.profile ADD COLUMN IF NOT EXISTS gmail_app_password_enc text;
ALTER TABLE public.profile ADD COLUMN IF NOT EXISTS gmail_verified_at timestamptz;

COMMENT ON COLUMN public.profile.gmail_app_password_enc IS
  'The user''s Gmail app password, AES-256-GCM encrypted (src/secrets.js). Never sent to the browser, not even masked. Saved only after a login against both SMTP and IMAP succeeded.';
COMMENT ON COLUMN public.profile.gmail_verified_at IS
  'When a login to Gmail with the stored app password last succeeded. NULL = not connected, or never verified.';
