-- ============================================================
-- What the app actually spends, and what the user allows it to.
--
-- Until now nothing was recorded. llm.js kept a 60-second window of
-- token counts in memory purely to drive its rate-limit breaker, so any
-- budget built on it would have been fiction: no history, gone on every
-- restart, and never converted to money.
--
-- One row per model call. Tokens AND the price applied at the time,
-- because model prices change and a cost recomputed later from today's
-- price list is not what was spent.
-- ============================================================
CREATE TABLE llm_usage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at                timestamptz NOT NULL DEFAULT now(),
  provider          text NOT NULL,
  model             text NOT NULL,
  tier              text,
  prompt_tokens     int,
  completion_tokens int,
  total_tokens      int,
  usd               numeric(12,8) NOT NULL DEFAULT 0
);

-- every read is "this month" or "today", so the index is on time
CREATE INDEX llm_usage_at ON llm_usage (at DESC);

COMMENT ON TABLE llm_usage IS
  'One row per LLM call, with the cost computed from the price in force at the time. The basis for the monthly budget; free tiers record 0 and still count towards volume.';

-- ------------------------------------------------------------
-- The budget is expressed in money because that is what runs out.
-- Everything else the user might cap — ads scored, letters sent — is
-- derived from it and from what the chosen models cost, so raising the
-- budget raises the capacity without the user doing arithmetic.
--
-- NULL means no ceiling: the app spends what the work requires, which
-- is the right default for a free-tier provider where the answer is
-- always nothing.
-- ------------------------------------------------------------
ALTER TABLE profile
  ADD COLUMN monthly_budget_usd numeric(10,2);

COMMENT ON COLUMN profile.monthly_budget_usd IS
  'Optional ceiling on model spend per calendar month. NULL = uncapped. daily_score_limit is derived from this when set.';
