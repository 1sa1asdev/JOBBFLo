import { createHash } from 'node:crypto';
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
// halfvec(768) column: text-embedding-3 is Matryoshka-trained, so a
// truncated vector is still a usable vector rather than a broken one.
// Keeping 768 halves the index and matches the column already in place.
//
// The columns are half precision (migration 061) because this model
// sends half-precision numbers. Before switching models, run
// scripts/check-halfvec.js: a model that sends full precision is
// rounded on the way in.
// ------------------------------------------------------------
// Embedding is the platform's cost, not a user's — the only AI work
// the operator pays for. Every ad in the shared pool is embedded once
// and serves everyone, and query vectors (a CV, a search) must come
// from the same model to be comparable, so they run here too.
//
// It therefore has its own key, PLATFORM_OPENROUTER_API_KEY: the
// operator's, ideally with a credit limit set on it at OpenRouter so
// the pool can never drain the account. This is the ONLY place in the
// app that reads an AI key from the environment; users' keys live on
// their profiles (src/llm.js).
//
// OPENROUTER_API_KEY is still accepted while an install moves over —
// locally the operator and the user are the same person — and the
// worker says so once.
// ------------------------------------------------------------
let sagtOmReserv = false;
function plattformsnyckel(egen, reserv) {
  const k = process.env[egen]?.trim();
  if (k) return k;
  const r = process.env[reserv]?.trim() || null;
  if (r && !sagtOmReserv) {
    sagtOmReserv = true;
    console.log(`embed: ${egen} saknas — använder ${reserv} tills plattformen har en egen nyckel`);
  }
  return r;
}

const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/embeddings',
    model: process.env.EMBED_MODEL || 'openai/text-embedding-3-small',
    key: () => plattformsnyckel('PLATFORM_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'),
    dimensions: EMBED_DIMS,
  },
  openai: {
    url: 'https://api.openai.com/v1/embeddings',
    model: process.env.EMBED_MODEL || 'text-embedding-3-small',
    key: () => plattformsnyckel('PLATFORM_OPENAI_API_KEY', 'OPENAI_API_KEY'),
    dimensions: EMBED_DIMS,
  },
  lmstudio: {
    url: `${LOCAL_URL}/embeddings`,
    model: process.env.EMBED_MODEL_LOCAL || 'text-embedding-nomic-embed-text-v1.5',
    key: null,
    dimensions: null,      // nomic is natively 768; it rejects the field
  },
};

// Which platform key this process holds, without the key: whether one
// is set, which variable it came from, and an eight-character
// fingerprint (the start of its SHA-256). The admin page shows the app's
// and the worker's side by side, so a rotation that reached Vercel but
// not Railway — or the reverse — is visible at a glance. Eight hex
// characters of a hash say nothing usable about a 70-character key.
const NYCKELNAMN = {
  openrouter: ['PLATFORM_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  openai: ['PLATFORM_OPENAI_API_KEY', 'OPENAI_API_KEY'],
};
export function nyckelStatus() {
  const cfg = embedConfig();
  const [egen, reserv] = NYCKELNAMN[cfg.provider] || [];
  const källa = egen && process.env[egen]?.trim() ? egen
    : reserv && process.env[reserv]?.trim() ? `${reserv} (reserv)` : null;
  return {
    leverantör: cfg.provider,
    behövs: Boolean(egen),
    satt: Boolean(cfg.key),
    källa,
    avtryck: cfg.key ? createHash('sha256').update(cfg.key).digest('hex').slice(0, 8) : null,
  };
}

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
  // The ad's own words, never a user's read of them.
  //
  // Building this vector from the requirement read (EMBED_FROM_PROFILE)
  // was tried and measured: scripts/prove-adprofile.js embedded the same
  // three jobs written three ways, and the read cut format dependence by
  // 22–52% but cost 14–20% discrimination every run — every ad rendered
  // into "## ROLL / ## KRAV" reads a little like every other ad. It was
  // never switched on, and it cannot be now: reads belong to the user
  // who made them (ad_reads), and this vector is the shared pool's,
  // paid for by the platform.
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
      `UPDATE ads SET embedding = $2::halfvec, embedding_model = $3, embedded_at = now()
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
export async function embedCv(profileId) {
  // Whose CV, always: the store below updates one profile, and it used
  // to update every profile with whichever CV came first.
  if (!profileId) throw new Error('embedCv: profileId krävs');
  const { rows: [p] } = await pool.query(
    `SELECT cv_text, cv_profile FROM profile WHERE id = $1`, [profileId]);
  if (!p?.cv_text?.trim()) return null;

  const { renderCvProfile } = await import('./cvprofile.js');
  const text = renderCvProfile(p.cv_profile) || p.cv_text;
  const cfg = embedConfig();
  const [v] = await embedTexts([text]);

  await pool.query(
    `UPDATE profile SET cv_embedding = $1::halfvec, cv_embedding_model = $2, cv_embedded_at = now()
     WHERE id = $3`,
    [toVector(v), `${cfg.provider}:${cfg.model}`, profileId]
  );
  return v.length;
}

// A search's own vector, built from its criteria alone. See below
// for why the CV is deliberately not in it.
export async function embedSearchQuery(searchId) {
  const { rows: [s] } = await pool.query(
    `SELECT criteria_text FROM searches WHERE id = $1`, [searchId]);
  if (!s) return null;

  // ------------------------------------------------------------
  // The criteria decide, the CV colours in.
  //
  // Both used to go in flat, and the CV is ten times longer — so the
  // vector was mostly a description of the candidate. That is harmless
  // while a search agrees with the CV, and actively wrong when it does
  // not: "deltid stockholm restaurang, cafe och bar" ranked
  // IT-tekniker, Extrajobb som IT-servicetekniker and webbredaktör
  // above every restaurant job, because the tech CV outvoted the eight
  // words the user actually typed. The one real restaurangbiträde in
  // the pool came sixth.
  //
  // A search that differs from the CV is not a mistake to be corrected;
  // it is usually the whole point — part-time work alongside studies,
  // in this case.
  //
  // Weighting the criteria and trimming the CV was tried first and was
  // not enough: every distance landed between 0.389 and 0.402, the CV
  // pulling the whole pool toward one centre. Criteria alone separates
  // cleanly — 0.352 for "Diskare till barer i Stockholm", then
  // Servitör, à la carte, restaurangbiträde, Bartender.
  //
  // So the CV is out of this vector entirely. It has not lost its job:
  // it decides SCORES, where a model reads the whole ad against the
  // whole candidate. This vector answers a narrower question — is this
  // ad about the thing the user asked for — and the CV was only ever
  // noise in that.
  const text = (s.criteria_text || '').trim();
  if (!text) return null;
  const cfg = embedConfig();
  const [v] = await embedTexts([text]);

  await pool.query(
    `UPDATE searches SET query_embedding = $2::halfvec, query_embedding_model = $3,
       query_embedded_at = now() WHERE id = $1`,
    [searchId, toVector(v), `${cfg.provider}:${cfg.model}`]
  );
  return v.length;
}
