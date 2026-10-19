-- ============================================================
-- A letter is out of your hands the moment SMTP accepts it.
--
-- sendApplication did three things in a row: hand the letter to Gmail,
-- write status='sent' with the message id, write the outbound message.
-- Nothing ties them together, and the first one cannot be undone. So a
-- database hiccup after Gmail said yes left the row reading 'drafted':
-- the employer has the letter, the app does not know, the card still
-- offers a Skicka button, and pressing it sends a second copy.
--
-- 'sending' is the row claiming itself before the letter leaves. It is
-- set in one conditional update — the same trick the campaign uses to
-- avoid sending an ad twice — so two runs cannot both claim it, and a
-- row stuck in 'sending' is a letter whose outcome is unknown rather
-- than one that looks unsent.
--
-- Nothing has to guess about those: the Sent-folder sync already finds
-- the user's own mail by recipient (src/imap.js, catchUpSent), which is
-- exactly the repair this needs.
-- ============================================================
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check
  CHECK (status = ANY (ARRAY['drafted', 'sending', 'sent', 'replied', 'interview',
                             'rejected', 'ghosted', 'withdrawn', 'undeliverable']));

-- When the claim was taken, so a row that never reached 'sent' can be
-- found and reconciled instead of sitting there for ever.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sending_since timestamptz;
