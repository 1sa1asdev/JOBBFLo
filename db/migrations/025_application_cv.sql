-- ============================================================
-- A different CV for one letter
--
-- The attached CV came from the search (tailored) or the profile
-- (base), so swapping it for a single application meant changing it for
-- every application in that search. But a CV is often the one thing you
-- want to vary per employer: a care job and a dev job want different
-- documents, and both can sit in the same search.
--
-- cv_text travels with the file, not just the bytes. The letter is
-- written FROM the CV, so storing only the attachment would let the
-- document and the prose describe different people — the letter arguing
-- from experience the attached CV never mentions. Whoever generates or
-- revises the letter reads this text when it is present.
-- ============================================================
ALTER TABLE applications
  ADD COLUMN cv_file     bytea,
  ADD COLUMN cv_filename text,
  ADD COLUMN cv_mime     text,
  ADD COLUMN cv_text     text;

COMMENT ON COLUMN applications.cv_file IS
  'Optional CV for THIS application only. Wins over the search''s tailored CV and the profile''s base CV. NULL = use those, as before.';
