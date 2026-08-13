-- ============================================================
-- 001: accounts. Additive — existing data survives.
--   users            login identity (email + scrypt hash)
--   profile.user_id  links a profile to its account (nullable so
--                    a seeded profile can be claimed at signup)
--   applications     become per-user: UNIQUE(profile_id, ad_id)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  password_hash   text NOT NULL,              -- scrypt$N$salt$hash
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profile ADD COLUMN IF NOT EXISTS
  user_id uuid UNIQUE REFERENCES users(id) ON DELETE CASCADE;

-- applications: one per ad PER USER (was: one per ad, ever)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS
  profile_id uuid REFERENCES profile(id) ON DELETE CASCADE;

-- backfill: everything so far belongs to the single existing profile
UPDATE applications SET profile_id = (SELECT id FROM profile LIMIT 1)
  WHERE profile_id IS NULL;

ALTER TABLE applications ALTER COLUMN profile_id SET NOT NULL;
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_ad_id_key;
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_profile_ad;
ALTER TABLE applications ADD CONSTRAINT applications_profile_ad UNIQUE (profile_id, ad_id);

-- the view must pick THIS search's owner's application for the ad,
-- not anyone's — the JOIN gains the profile condition
CREATE OR REPLACE VIEW search_results AS
SELECT
  m.search_id,
  a.id            AS ad_id,
  a.title,
  a.employer,
  a.municipality,
  a.deadline,
  a.ats_vendor,
  m.score,
  m.summary,
  m.flags,
  app.status      AS application_status,
  app.sent_at,
  app.origin_search_id,
  (app.id IS NOT NULL AND m.search_id <> app.origin_search_id) AS applied_via_other_search,
  (na.fingerprint IS NOT NULL) AS suppressed
FROM match_results m
JOIN searches s      ON s.id = m.search_id
JOIN ads a           ON a.id = m.ad_id
LEFT JOIN applications app ON app.ad_id = a.id AND app.profile_id = s.profile_id
LEFT JOIN never_apply na   ON na.fingerprint = a.fingerprint
WHERE a.removed_at IS NULL;
