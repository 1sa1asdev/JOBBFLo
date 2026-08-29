-- ============================================================
-- EMBEDDINGS: rank without asking a model.
--
-- Ranking an ad against the candidate was only possible via scoreAd —
-- one LLM call per ad, repeated every time the criteria changed. An
-- embedding is computed ONCE per ad and every future ranking is vector
-- arithmetic in Postgres: free, instant, and repeatable.
--
-- Measured on this pool: 810 tokens per ad, 27k ads. That is $0.44 as
-- a one-off on a hosted model, or nothing at all locally — against
-- $0.00011 PER AD PER SCORING PASS, which recurs.
--
-- Embeddings RANK, they do not judge. They cannot produce the verbatim
-- quotes, flags or reasoning the letter pipeline depends on, so this
-- replaces the prefilter, never scoreAd.
--
-- The model and dimension are stored ALONGSIDE every vector. Vectors
-- from different models are not comparable — cosine distance between a
-- 768-dim nomic vector and a 1536-dim OpenAI one is meaningless and
-- raises no error. Recording the model is what makes a model change a
-- visible re-embed rather than a silent corruption of every ranking.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- 768 dims = nomic-embed-text-v1.5, the local model already downloaded
-- in LM Studio. Changing model means changing this type, which is
-- deliberately a migration and not a config flag.
ALTER TABLE ads
  ADD COLUMN embedding       vector(768),
  ADD COLUMN embedding_model text,
  ADD COLUMN embedded_at     timestamptz;

COMMENT ON COLUMN ads.embedding_model IS
  'Which model produced this vector. Vectors from different models must never be compared.';

-- The query side: the CV read once, embedded once. Rebuilt only when
-- the CV or its profile changes, so this is one call in the app's life.
ALTER TABLE profile
  ADD COLUMN cv_embedding       vector(768),
  ADD COLUMN cv_embedding_model text,
  ADD COLUMN cv_embedded_at     timestamptz;

-- A search may carry its own tailored CV and its own criteria, so it
-- gets its own query vector rather than borrowing the profile's.
ALTER TABLE searches
  ADD COLUMN query_embedding       vector(768),
  ADD COLUMN query_embedding_model text,
  ADD COLUMN query_embedded_at     timestamptz;

-- HNSW over cosine: the ranking is "most similar to this CV", which is
-- an angle question, not a magnitude one. Partial, because an ad
-- without a vector can never be a nearest neighbour.
CREATE INDEX ads_embedding_hnsw ON ads
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- The embed worker's queue: ads still missing a vector. Partial so it
-- shrinks to nothing as the backfill completes.
CREATE INDEX ads_needs_embedding ON ads (published_at DESC NULLS LAST)
  WHERE embedding IS NULL AND removed_at IS NULL;
