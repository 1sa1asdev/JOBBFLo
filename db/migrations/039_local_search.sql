-- ============================================================
-- Indexes for answering a search from the pool instead of the API.
--
-- Every one is partial on open ads: a search only ever looks at ads
-- that can still be applied to, about 37k rows of a table that keeps
-- its history for ever.
--
-- On concept_id, not on the label, because that is what the filters
-- carry once resolved — and because the labels disagree with the
-- filter names (an ad reads "Tillsvidareanställning (inkl. eventuell
-- provanställning)" while the filter is "Tillsvidareanställning").
--
-- The values live inside raw because that is what the feed sends;
-- promoting them to columns would mean rewriting every row whenever
-- the feed adds a field. An expression index costs the same to read.
-- ============================================================
DROP INDEX IF EXISTS ads_open_muni_idx;
DROP INDEX IF EXISTS ads_open_region_idx;
DROP INDEX IF EXISTS ads_open_group_idx;
DROP INDEX IF EXISTS ads_open_field_idx;
DROP INDEX IF EXISTS ads_open_name_idx;
DROP INDEX IF EXISTS ads_open_worktime_idx;

CREATE INDEX IF NOT EXISTS ads_open_muni_c_idx
  ON ads ((raw->'workplace_address'->>'municipality_concept_id')) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ads_open_region_c_idx
  ON ads ((raw->'workplace_address'->>'region_concept_id')) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ads_open_field_c_idx
  ON ads ((raw->'occupation_field'->>'concept_id')) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ads_open_group_c_idx
  ON ads ((raw->'occupation_group'->>'concept_id')) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ads_open_name_c_idx
  ON ads ((raw->'occupation'->>'concept_id')) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ads_open_worktime_c_idx
  ON ads ((raw->'working_hours_type'->>'concept_id')) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ads_open_employment_c_idx
  ON ads ((raw->'employment_type'->>'concept_id')) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ads_open_deadline_idx
  ON ads (deadline) WHERE removed_at IS NULL;

-- Free text, stored rather than recomputed.
--
-- An expression index alone was not enough: with a place filter the
-- planner scans by municipality and rechecks the text condition per
-- row, which re-runs to_tsvector over 6000 descriptions — 766ms for
-- one count. Stored, the same count is a few milliseconds.
ALTER TABLE ads ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('swedish',
    coalesce(title, '') || ' ' || coalesce(description, ''))) STORED;
CREATE INDEX IF NOT EXISTS ads_open_fts_idx ON ads USING gin (fts) WHERE removed_at IS NULL;
