-- ============================================================
-- 004: keep the CV FILE, not just its text.
--
-- Uploads previously extracted text and threw the file away, so
-- applications went out with a letter and no CV attached — even
-- though the ads ask for both. The text still drives scoring and
-- letter writing; the bytes exist purely to attach on send.
-- ============================================================

ALTER TABLE profile  ADD COLUMN IF NOT EXISTS cv_file bytea;
ALTER TABLE profile  ADD COLUMN IF NOT EXISTS cv_mime text;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS cv_file bytea;
ALTER TABLE searches ADD COLUMN IF NOT EXISTS cv_mime text;

-- extra documents (betyg, intyg, portfolio) attached to every
-- application, mirroring the mockup's "Lägg till fler filer"
CREATE TABLE IF NOT EXISTS attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  mime        text,
  bytes       bytea NOT NULL,
  size_bytes  int NOT NULL,
  include_by_default boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_profile ON attachments(profile_id);
