-- ============================================================
-- Which files went with a message we sent.
--
-- Replies from the inbox can now carry files: the CV, a document the
-- user has uploaded before, or a file picked for this reply. The bytes
-- are not kept a second time — the copy in the user's own Gmail Sent
-- folder is the record of what left — but the thread has to say what
-- was attached, or "did I send them the certificate?" means opening
-- Gmail to find out.
-- ============================================================
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS attachments jsonb;

COMMENT ON COLUMN public.email_messages.attachments IS
  'Files sent with this message, as [{filename, size}] — names and sizes only; the file itself is in the sender''s Gmail Sent folder. NULL when nothing was attached, and for inbound mail.';
