-- ============================================================
-- Applications the user made through the ad's own link.
--
-- 90 of 147 favourites (61%) publish no apply_email at all — they can
-- only be applied to through a link or an ATS. For those the app could
-- write the letter and then did nothing: the row sat at 'drafted'
-- forever, invisible in the inbox, with no deadline warning and no
-- follow-up. The user had applied; Jobbflo had no idea.
--
-- 'external' is a third sender alongside 'user' and 'auto', not a
-- status, because the STATE is the same as any sent application
-- (waiting, replied, rejected) — what differs is who put it in the
-- post. That distinction is load-bearing:
--
--   * There is no message_id, so reply matching cannot use rule 1 or 2
--     (In-Reply-To / References). It falls to the domain rule, which is
--     why applied_via_url is stored — the host is the only thread we
--     have back to this employer.
--   * calibration() must exclude these. A reply to an external
--     application often arrives in a fresh thread or an ATS we cannot
--     see, so "no reply" here does not mean silence — counting it as a
--     miss would quietly depress every response rate in the app.
-- ============================================================

ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_sent_by_check;
ALTER TABLE applications ADD CONSTRAINT applications_sent_by_check
  CHECK (sent_by = ANY (ARRAY['user'::text, 'auto'::text, 'external'::text]));

COMMENT ON COLUMN applications.sent_by IS
  'user = sent from the app by a click; auto = a campaign sent it; external = the user applied through the ad''s own link and told us afterwards (no message_id, excluded from calibration).';

-- Where the user actually applied. Not an email, so it cannot live in
-- sent_to — and the host is what rule 3 needs to match a reply.
ALTER TABLE applications
  ADD COLUMN applied_via_url text;

COMMENT ON COLUMN applications.applied_via_url IS
  'The ad link the user applied through. Its host is the only handle domain-based reply matching has for an external application.';
