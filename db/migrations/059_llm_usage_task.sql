-- ============================================================
-- What each AI call was for, and what it belonged to.
--
-- llm_usage knew the tier (fast/bulk/write), not the task: "fast" both
-- reads an ad's requirements and classifies a reply, "bulk" both grades
-- and re-reads thin ads. So the cost of one judged ad or one sent
-- application could only be guessed by splitting tiers — and the coming
-- budget ("what $10 a month buys you") must be built on what things
-- actually cost, per task, per model, per campaign.
--
-- usd_källa: OpenRouter reports what a call cost; that number is used
-- as it is. Otherwise it is tokens × the listed price, or nothing for a
-- local model.
-- ============================================================
ALTER TABLE public.llm_usage ADD COLUMN IF NOT EXISTS uppgift text;
ALTER TABLE public.llm_usage ADD COLUMN IF NOT EXISTS search_id uuid
  REFERENCES public.searches(id) ON DELETE SET NULL;
ALTER TABLE public.llm_usage ADD COLUMN IF NOT EXISTS ad_id uuid
  REFERENCES public.ads(id) ON DELETE SET NULL;
ALTER TABLE public.llm_usage ADD COLUMN IF NOT EXISTS application_id uuid
  REFERENCES public.applications(id) ON DELETE SET NULL;
ALTER TABLE public.llm_usage ADD COLUMN IF NOT EXISTS usd_källa text NOT NULL DEFAULT 'listpris'
  CHECK (usd_källa IN ('leverantör', 'listpris', 'gratis'));

-- What was recorded before this: the tier is known, the task is not.
UPDATE public.llm_usage SET uppgift = 'före mätningen' WHERE uppgift IS NULL;

CREATE INDEX IF NOT EXISTS llm_usage_profile_at ON public.llm_usage (profile_id, at);
CREATE INDEX IF NOT EXISTS llm_usage_uppgift ON public.llm_usage (uppgift, at);

COMMENT ON COLUMN public.llm_usage.uppgift IS
  'What the call did (src/uppgifter.js): läsa_krav, bedöma, brev, brev_revidera, brev_kontroll, svar_klassa, svar_utkast, intervju, påminnelse, kriterier_chatt, kriterier_tolka, kampanj_chatt, cv_profil, lead_tolka, test. "före mätningen" for rows recorded before migration 059.';
COMMENT ON COLUMN public.llm_usage.usd_källa IS
  'leverantör: the cost OpenRouter reported for this call. listpris: tokens × the listed price. gratis: a local model.';
