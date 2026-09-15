-- ============================================================
-- What the model last read out of the criteria, kept apart from what
-- is actually in force.
--
-- Every chat message re-parses the whole criteria text and used to
-- write the result straight over api_filters. A filter the user had
-- switched on by hand — a suggestion chip, the Ort picker, Omfattning —
-- vanished on the next message about something else entirely, and
-- nothing said so.
--
-- With the last parse on record, a hand change is simply where
-- api_filters and parsed_filters disagree. A re-parse keeps those,
-- unless the new parse moved that same key — then the user has just
-- said something about it in words, and the newer statement wins.
--
-- Existing searches start with parsed_filters = api_filters: nothing
-- is known to be a hand change yet, which is exactly today's behaviour.
-- ============================================================
ALTER TABLE searches ADD COLUMN IF NOT EXISTS parsed_filters jsonb;
UPDATE searches SET parsed_filters = api_filters WHERE parsed_filters IS NULL;
