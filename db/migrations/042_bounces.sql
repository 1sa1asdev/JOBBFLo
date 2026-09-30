-- ============================================================
-- A letter that never arrived is not an answer.
--
-- Bounce notices from Gmail ("Delivery Status Notification
-- (Failure)", sender mailer-daemon@googlemail.com) were matched to the
-- application they were about, handed to the classifier, and read as
-- the employer's reply. Measured before this: 19 of 124 "avslag" were
-- bounces — 15% of the rejection rate was mail that never left the
-- building.
--
-- Three things went wrong at once, and the status is what fixes them:
--   the dashboard counted a rejection that never happened
--   the application counted as answered, so the ad was never retried
--   the bad address stayed on the ad, ready to bounce again
--
-- 'undeliverable' is a terminal status like 'rejected', so a bounced
-- application leaves the open set and stops being chased — but it says
-- what actually happened, and the address is cleared with it.
-- ============================================================
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check
  CHECK (status = ANY (ARRAY['drafted', 'sent', 'replied', 'interview',
                             'rejected', 'ghosted', 'withdrawn', 'undeliverable']));

-- Which address bounced, kept on the row after apply_email is cleared
-- from the ad: without it the only record of the bad address is a log
-- line, and a scraped address that bounces once will be scraped again.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bounced_at timestamptz;
