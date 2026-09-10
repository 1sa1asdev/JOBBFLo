-- ============================================================
-- When the user actually opened an ad's own application link.
--
-- "✓ Sökt" marks a link-only ad as applied to, and the app has no way
-- to observe that: the application happens on the employer's site. So
-- the button recorded a claim rather than a fact, and it was available
-- on every link-only ad in the list — one stray click and a job you
-- never applied to is filed as done, invisible from then on.
--
-- Opening the link from inside the app is the one moment the app CAN
-- observe. It does not prove an application was submitted, but it is
-- the difference between "I did this" and "I may have meant to": the
-- button now needs either this, or a letter written for the ad.
--
-- Per ad, not per search. Opening a link is a fact about the ad and the
-- person, not about which search happened to surface it.
-- ============================================================
ALTER TABLE ads ADD COLUMN apply_url_opened_at timestamptz;

COMMENT ON COLUMN ads.apply_url_opened_at IS
  'Last time the user opened this ad''s application link from inside the app. Gates the "✓ Sökt" button.';
