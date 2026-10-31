-- ============================================================
-- Two indexes on ads that were each a copy of another, dropped.
--
-- 037 added ads_fingerprint_idx (fingerprint) and 039 added
-- ads_open_deadline_idx (deadline WHERE removed_at IS NULL) with
-- IF NOT EXISTS under new names, so both were built beside the
-- baseline's ads_fingerprint and ads_deadline, which are the same
-- column, the same order and the same predicate. A query can use only
-- one of a pair; every new or changed ad paid to keep both. They were
-- the only duplicates in the schema.
--
-- The baseline's names stay. Dropping is quick, but it waits for the
-- table like any other DDL, so the wait is bounded as in 062.
-- ============================================================
SET LOCAL lock_timeout = '60s';

DROP INDEX IF EXISTS public.ads_fingerprint_idx;
DROP INDEX IF EXISTS public.ads_open_deadline_idx;

COMMENT ON INDEX public.ads_fingerprint IS
  'Same posting under another id: the soft dedupe flag (CLAUDE.md invariant 4), verdict reuse and never_apply. The only fingerprint index; a second identical one from 037 was dropped in 064.';
COMMENT ON INDEX public.ads_deadline IS
  'Open ads by deadline: retirement and the pool''s deadline filters. The only one; an identical ads_open_deadline_idx from 039 was dropped in 064.';
