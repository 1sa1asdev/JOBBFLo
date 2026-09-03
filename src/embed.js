import { pool } from './db.js';

// ------------------------------------------------------------
// Embeddings: the free half of matching.
//
// scoreAd answers "how well does this ad fit, and why" — expensive,
// per ad, per criteria change. An embedding answers "how close is this
// ad to what the candidate is" — computed once per ad, then reusable
// forever as vector arithmetic in Postgres.
//
// This never replaces scoreAd. It has no idea what a requirement is
// and cannot quote anything; it only orders. Its job is to make sure
// the ads a human sees first are the ones worth seeing.
//
// Local by default: the CV is the most personal thing this app holds,
// and nomic-embed-text runs on the machine that already has it.
// ------------------------------------------------------------

export const EMBED_DIMS = 768;                       // nomic-embed-text-v1.5
const LOCAL_URL = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';

// `dimensions` is what lets a 1536-wide OpenAI model fill a
// vector(768) column: text-embedding-3 is Matryoshka-trained, so a
// truncated vector is still a usable vector rather than a broken one.
// Keeping 768 halves the index and matches the column already in place.
const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/embeddings',
    model: process.env.EMBED_MODEL || 'openai/text-embedding-3-small',
    key: () => process.env.OPENROUTER_API_KEY,
    dimensions: EMBED_DIMS,
  },
  openai: {
    url: 'https://api.openai.com/v1/embeddings',
    model: process.env.EMBED_MODEL || 'text-embedding-3-small',
    key: () => process.env.OPENAI_API_KEY,
    dimensions: EMBED_DIMS,
  },
  lmstudio: {
    url: `${LOCAL_URL}/embeddings`,
    model: process.env.EMBED_MODEL_LOCAL || 'text-embedding-nomic-embed-text-v1.5',
    key: null,
    dimensions: null,      // nomic is natively 768; it rejects the field
  },
};

export function embedConfig() {
  const want = (process.env.EMBED_PROVIDER || 'openrouter').toLowerCase();
  const p = PROVIDERS[want] || PROVIDERS.openrouter;
  return { provider: want, ...p, key: typeof p.key === 'function' ? p.key() : p.key };
}

// One HTTP call, many texts. Batching matters: per-request overhead
// dominates on a local server, and 27k ads one at a time is hours of
// handshakes rather than work.
export async function embedTexts(texts, { signal } = {}) {
  if (!texts.length) return [];
  const cfg = embedConfig();
  const headers = { 'content-type': 'application/json' };
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: cfg.model,
      input: texts,
      ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 160);
    const err = new Error(`embedding ${cfg.provider} ${res.status}: ${body}`);
    // 402/401/403 will not fix themselves — no amount of retrying buys
    // credits. Only rate limits and server faults are worth waiting on.
    err.status = res.status;
    err.transient = res.status === 429 || res.status >= 500;
    throw err;
  }
  const body = await res.json();
  // the API may return results out of order; `index` is authoritative
  const out = new Array(texts.length);
  for (const d of body.data || []) out[d.index] = d.embedding;

  for (const [i, v] of out.entries()) {
    if (!Array.isArray(v)) throw new Error(`embedding saknas för text ${i}`);
    if (v.length !== EMBED_DIMS) {
      // Guard the one failure that is silent otherwise: a model with a
      // different width produces vectors that compare against nothing.
      throw new Error(
        `fel dimension: ${cfg.model} gav ${v.length}, schemat kräver ${EMBED_DIMS}. `
        + 'Byt modell eller migrera kolumnen — blanda aldrig.'
      );
    }
  }
  return out;
}

const toVector = (v) => `[${v.join(',')}]`;

// What an ad "is", for matching purposes. Title and occupation carry
// most of the signal and the description adds context; the tail of a
// long ad is benefits boilerplate that dilutes the vector.
export function adEmbedText(ad) {
  return [
    ad.title,
    ad.occupation,
    ad.employer,
    ad.municipality,
    (ad.description || '').slice(0, 2000),
  ].filter(Boolean).join('\n');
}

// ------------------------------------------------------------
// Embed ads that lack a vector. Returns how many it did, so a caller
// can loop until it returns 0.
// ------------------------------------------------------------
export async function embedPendingAds({ limit = 64 } = {}) {
  const { rows: ads } = await pool.query(
    `SELECT a.id, a.title, a.employer, a.municipality, a.description,
            a.raw->'occupation'->>'label' AS occupation
     FROM ads a
     -- Never pay to embed an ad that can no longer be applied to. This
     -- also closes the loop with releaseExpiredVectors(): without it,
     -- every vector released at expiry would be bought again on the next
     -- tick, for ever.
     WHERE a.embedding IS NULL AND a.removed_at IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
     ORDER BY a.published_at DESC NULLS LAST
     LIMIT $1`, [limit]
  );
  if (!ads.length) return 0;

  const cfg = embedConfig();
  const vectors = await embedTexts(ads.map(adEmbedText));

  for (const [i, ad] of ads.entries()) {
    await pool.query(
      `UPDATE ads SET embedding = $2::vector, embedding_model = $3, embedded_at = now()
       WHERE id = $1`,
      [ad.id, toVector(vectors[i]), `${cfg.provider}:${cfg.model}`]
    );
  }
  return ads.length;
}

// ------------------------------------------------------------
// The query side. Embeds the CV profile rather than the raw CV: it is
// the cleaner signal and it already exists.
// ------------------------------------------------------------
export async function embedCv() {
  const { rows: [p] } = await pool.query(
    `SELECT cv_text, cv_profile FROM profile LIMIT 1`);
  if (!p?.cv_text?.trim()) return null;

  const { renderCvProfile } = await import('./cvprofile.js');
  const text = renderCvProfile(p.cv_profile) || p.cv_text;
  const cfg = embedConfig();
  const [v] = await embedTexts([text]);

  await pool.query(
    `UPDATE profile SET cv_embedding = $1::vector, cv_embedding_model = $2, cv_embedded_at = now()`,
    [toVector(v), `${cfg.provider}:${cfg.model}`]
  );
  return v.length;
}

// A search's own vector: its criteria plus whichever CV applies to it.
export async function embedSearchQuery(searchId) {
  const { rows: [s] } = await pool.query(
    `SELECT s.criteria_text, COALESCE(s.cv_profile, p.cv_profile) AS cv_profile,
            COALESCE(s.cv_text, p.cv_text) AS cv_text
     FROM searches s JOIN profile p ON p.id = s.profile_id
     WHERE s.id = $1`, [searchId]);
  if (!s) return null;

  const { renderCvProfile } = await import('./cvprofile.js');
  const text = [s.criteria_text, renderCvProfile(s.cv_profile) || s.cv_text]
    .filter(Boolean).join('\n\n');
  const cfg = embedConfig();
  const [v] = await embedTexts([text]);

  await pool.query(
    `UPDATE searches SET query_embedding = $2::vector, query_embedding_model = $3,
       query_embedded_at = now() WHERE id = $1`,
    [searchId, toVector(v), `${cfg.provider}:${cfg.model}`]
  );
  return v.length;
}
