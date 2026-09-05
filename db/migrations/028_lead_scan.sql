-- ============================================================
-- Where an ad's address came from.
--
-- 1082 of a campaign's 1149 ads publish no apply_email, so the campaign
-- cannot write to them at all — by far the largest thing standing
-- between the user and more applications. Many of those links do carry
-- an address on the page; a sample of ten yielded four, and every
-- Teamtailor page in the sample named the recruiter directly.
--
-- An address found by reading a page is not the same fact as one the
-- API published, and it must not pretend to be: it can be a support
-- desk, the wrong person, or a webmaster. Recording the source lets the
-- UI say which is which, and lets a scanned address be treated as a
-- suggestion the user confirms rather than something to mail blindly.
--
-- upsertAd's ON CONFLICT deliberately does not touch apply_email, so a
-- found address already survives the next poll. This column records
-- provenance, not protection.
-- ============================================================
ALTER TABLE ads
  ADD COLUMN apply_email_source text
    CHECK (apply_email_source IN ('api', 'scanned', 'manual')),
  ADD COLUMN apply_email_found_at timestamptz;

-- Everything that has an address today came from Arbetsförmedlingen.
UPDATE ads SET apply_email_source = 'api' WHERE apply_email IS NOT NULL;

COMMENT ON COLUMN ads.apply_email_source IS
  'api = published by Arbetsförmedlingen; scanned = read off the ad page and confirmed by the user; manual = typed in by hand.';
