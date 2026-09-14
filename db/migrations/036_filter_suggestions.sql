-- ============================================================
-- Filters the user stated, and filters the app only suggests.
--
-- parseCriteria used to apply everything it could infer: "sätt ALLTID
-- occupation-field". So a search for "utvecklare" silently became
-- Data/IT, and the user never saw that a narrowing had happened or had
-- the chance to say no. A filter is now ON only when the user's own
-- words name it; anything the app could narrow further is offered in
-- the chat, with the hit count it would cost, and applied on a click.
--
-- taxonomy_vectors: the occupation taxonomy, embedded once. Suggesting
-- an occupation group used to mean asking a model to produce a label
-- that then had to match Arbetsförmedlingen's exact wording —
-- "frontendutvecklare" resolved to nothing, and a label the model
-- paraphrased fell through to free text. Nearest-neighbour over the
-- real labels is milliseconds, needs no model call, and can only ever
-- return a concept that exists.
-- ============================================================
CREATE TABLE IF NOT EXISTS taxonomy_vectors (
  type        text NOT NULL,
  concept_id  text NOT NULL,
  label       text NOT NULL,
  embedding   vector(768) NOT NULL,
  PRIMARY KEY (type, concept_id)
);
CREATE INDEX IF NOT EXISTS taxonomy_vectors_hnsw
  ON taxonomy_vectors USING hnsw (embedding vector_cosine_ops);

-- Structured payload on a chat message: the suggestions an assistant
-- turn offered, and which of them the user has since applied.
ALTER TABLE search_messages ADD COLUMN IF NOT EXISTS meta jsonb;
