-- ============================================================
-- Who a campaign has written to — permanently.
--
-- The record already survives a rule change: editing the threshold, the
-- places or the hard requirement never touches an application. What it
-- did NOT survive is the search being deleted. origin_search_id is
-- ON DELETE SET NULL (deliberately — "find similar jobs" degrades to a
-- disabled button rather than breaking), so deleting the search would
-- silently orphan every letter it had sent from the campaign that sent
-- them.
--
-- The name is therefore copied onto the application when it goes out.
-- Denormalising is usually how CRM-E's bug was born, but this is the
-- opposite case: not a status that must stay in sync, a historical fact
-- that must NOT change when the campaign is later renamed. Who you wrote
-- to under "Fullstack utvecklare" stays written under that name even if
-- the campaign becomes something else tomorrow.
-- ============================================================
ALTER TABLE applications
  ADD COLUMN campaign_name text;

COMMENT ON COLUMN applications.campaign_name IS
  'The campaign name as it stood when this letter was sent. A historical fact, not a mirror: it deliberately does not follow later renames, and outlives the search being deleted.';

-- Backfill from the searches that still exist, so today's history is
-- not left blank by the migration that was meant to protect it.
UPDATE applications a
   SET campaign_name = s.name
  FROM searches s
 WHERE s.id = a.origin_search_id
   AND a.sent_by = 'auto'
   AND a.campaign_name IS NULL;
