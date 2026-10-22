-- ============================================================
-- OpenRouter, LM Studio and Ollama — the only AI providers.
--
-- There were eleven. Each brought its own models, prices and failure
-- modes, so the measured tokens per task, the cost estimate and the
-- coming budget described no one user in particular. OpenRouter reaches
-- the models Jobbflo is run on and reports what a call cost; LM Studio
-- and Ollama keep everything on the user's own machine. Which
-- OpenRouter models may be picked is the operator's list
-- (platform_settings.llm_modeller, src/modeller.js).
--
-- A profile on a provider that is gone loses that choice, key and
-- models with it, and is asked to choose again (the first-run guide and
-- "Kom igång" both see no AI). When this ran, every profile in every
-- database was on OpenRouter.
--
-- The check makes the list the database's rule too: code that writes
-- another provider fails here instead of leaving a user who cannot be
-- called.
-- ============================================================
UPDATE public.profile
   SET llm_provider = NULL, llm_api_key_enc = NULL, llm_base_url = NULL,
       llm_model_smart = NULL, llm_model_fast = NULL, llm_model_bulk = NULL, llm_model_write = NULL,
       updated_at = now()
 WHERE llm_provider IS NOT NULL AND llm_provider NOT IN ('openrouter', 'lmstudio', 'ollama');

-- Extra keys for cross-provider chains, for providers that no longer exist.
UPDATE public.profile
   SET llm_keys_enc = (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                       FROM jsonb_each(llm_keys_enc) AS e(k, v)
                       WHERE k IN ('openrouter', 'lmstudio', 'ollama'))
 WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(llm_keys_enc) AS k
               WHERE k NOT IN ('openrouter', 'lmstudio', 'ollama'));

-- OpenRouter's address is fixed; only a local model has one of the user's.
UPDATE public.profile SET llm_base_url = NULL
 WHERE llm_provider = 'openrouter' AND llm_base_url IS NOT NULL;

ALTER TABLE public.profile ADD CONSTRAINT profile_llm_provider_check
  CHECK (llm_provider IS NULL OR llm_provider IN ('openrouter', 'lmstudio', 'ollama'));

COMMENT ON COLUMN public.profile.llm_provider IS
  'openrouter, lmstudio or ollama (migration 063). OpenRouter models are limited to platform_settings.llm_modeller; a local provider''s address must be one the server may call (src/adress.js).';
COMMENT ON COLUMN public.profile.llm_base_url IS
  'Only for lmstudio/ollama: the address of the user''s own model server. With login on it must be public https (src/adress.js), checked when saved and on every call.';
