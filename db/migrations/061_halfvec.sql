-- ============================================================
-- Vectors at half precision.
--
-- text-embedding-3-small, through OpenRouter, sends numbers that are
-- already half precision: all 42 162 local ad vectors, the search
-- vectors and the CV vector came back identical after a round trip
-- through halfvec. vector(768) spent 4 bytes on numbers that carry 2,
-- so every ad paid 3 KB for 1.5 KB of information. Checked before the
-- switch: the same 1500 ads, in the same order, with the same
-- similarity, for every search and the CV.
--
-- (The ad vector index went in 060: nothing could use it.)
--
-- A model that sends full precision would be rounded by these columns:
-- scripts/check-halfvec.js says whether it matters before switching.
-- ============================================================

-- Rewriting ads takes its lock for the duration. Better to fail and
-- run again than to queue behind a long query with every request
-- queued behind this.
SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = 0;

DROP INDEX IF EXISTS public.taxonomy_vectors_hnsw;

ALTER TABLE public.ads ALTER COLUMN embedding TYPE public.halfvec(768);
ALTER TABLE public.profile ALTER COLUMN cv_embedding TYPE public.halfvec(768);
ALTER TABLE public.searches ALTER COLUMN query_embedding TYPE public.halfvec(768);
ALTER TABLE public.taxonomy_vectors ALTER COLUMN embedding TYPE public.halfvec(768);

-- The occupation lookup does read nearest-first with a LIMIT, which is
-- what HNSW is for; the table is small, so this one stays.
CREATE INDEX IF NOT EXISTS taxonomy_vectors_hnsw
  ON public.taxonomy_vectors USING hnsw (embedding public.halfvec_cosine_ops);

COMMENT ON COLUMN public.ads.embedding IS
  'The ad as a vector, at half precision: text-embedding-3-small sends half-precision numbers, so nothing is lost (migration 061). No vector index: every ranking query orders by (embedding IS NULL) first and reads up to 1500 filtered rows, which HNSW cannot serve.';
COMMENT ON COLUMN public.profile.cv_embedding IS
  'The CV as a vector, half precision like ads.embedding (migration 061).';
COMMENT ON COLUMN public.searches.query_embedding IS
  'The search criteria as a vector, half precision like ads.embedding (migration 061).';
COMMENT ON COLUMN public.taxonomy_vectors.embedding IS
  'The occupation label as a vector, half precision like ads.embedding (migration 061).';
