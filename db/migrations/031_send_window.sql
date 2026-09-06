-- ============================================================
-- When a campaign is allowed to send.
--
-- A cold letter that lands at 03:00 on a Sunday is read on Monday
-- alongside the weekend's backlog, if at all. The user should be able to
-- say "only 10-12, Monday to Thursday" and have that mean what it says.
--
-- The clock is the sharp edge here. This database runs in UTC while the
-- user and every recruiter they write to live in Europe/Stockholm — two
-- hours apart in summer, one in winter. Comparing now()::time against a
-- stored 10:00 would have sent at 08:00 Swedish time, which is exactly
-- the kind of quietly-wrong that never gets reported as a bug.
-- Every comparison is therefore explicit about the zone.
--
-- NULL means no restriction, which is the right default: a campaign that
-- has never been told when to send should send whenever it can.
-- ============================================================
ALTER TABLE searches
  ADD COLUMN send_days smallint[],          -- ISO weekdays, 1=måndag … 7=söndag
  ADD COLUMN send_from time,
  ADD COLUMN send_to   time;

COMMENT ON COLUMN searches.send_days IS
  'ISO weekdays the campaign may send on (1=Monday). NULL = any day. Evaluated in Europe/Stockholm, not UTC.';
COMMENT ON COLUMN searches.send_from IS
  'Start of the daily sending window in Europe/Stockholm. NULL = no restriction. If send_from > send_to the window wraps past midnight.';
