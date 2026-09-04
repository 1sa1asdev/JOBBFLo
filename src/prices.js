import { pool } from './db.js';

// ------------------------------------------------------------
// What a model call costs.
//
// Prices come from OpenRouter, which publishes them per model and per
// token, and are cached for an hour — they change rarely and a stale
// price is far better than a failed request or a blocked call.
//
// A model we have no price for is recorded at 0 rather than guessed.
// Inventing a number would put fiction into the budget the user is
// about to make decisions with; a zero is visibly incomplete, and the
// volume is still counted.
// ------------------------------------------------------------
let cache = null;
let cachedAt = 0;
const TTL = 60 * 60 * 1000;

export async function priceTable() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const { data } = await res.json();
    cache = new Map(data.map((m) => [m.id, {
      prompt: Number(m.pricing?.prompt) || 0,
      completion: Number(m.pricing?.completion) || 0,
    }]));
    cachedAt = Date.now();
  } catch {
    // keep whatever we had; an outage must not stop the app from working
    if (!cache) cache = new Map();
  }
  return cache;
}

// Groq's free tier really is free, and a local model costs nothing to
// call. Saying so explicitly stops those provider's calls from being
// silently priced with an OpenRouter figure for the same model name.
const FREE_PROVIDERS = new Set(['groq', 'ollama', 'lmstudio']);

export async function costOf({ provider, model, promptTokens, completionTokens }) {
  if (FREE_PROVIDERS.has(provider)) return 0;
  const p = (await priceTable()).get(model);
  if (!p) return 0;
  return (Number(promptTokens) || 0) * p.prompt
       + (Number(completionTokens) || 0) * p.completion;
}

export async function recordUsage(entry) {
  const usd = await costOf(entry);
  await pool.query(
    `INSERT INTO llm_usage
       (provider, model, tier, prompt_tokens, completion_tokens, total_tokens, usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [entry.provider, entry.model, entry.tier || null,
     entry.promptTokens ?? null, entry.completionTokens ?? null,
     entry.totalTokens ?? null, usd]
  ).catch(() => { /* metering must never break the call it measures */ });
  return usd;
}

// ------------------------------------------------------------
// What one unit of work costs, measured rather than assumed.
//
// The averages come from this install's own history, so they reflect the
// actual CV length, ad length and prompt — a figure taken from the model
// card would be wrong for this user specifically. Falls back to a
// measured default until there is history to read.
// ------------------------------------------------------------
export async function unitCosts() {
  const { rows } = await pool.query(
    `SELECT tier, avg(usd)::numeric(12,8) AS usd, count(*)::int AS calls
     FROM llm_usage
     WHERE at > now() - interval '30 days' AND tier IS NOT NULL
     GROUP BY tier`
  );
  const seen = Object.fromEntries(rows.map((r) => [r.tier, {
    usd: Number(r.usd), calls: r.calls,
  }]));
  return {
    // one ad judged; one letter written
    score: seen.bulk?.usd ?? 0.0017,
    letter: seen.write?.usd ?? 0.00016,
    measured: { score: seen.bulk?.calls || 0, letter: seen.write?.calls || 0 },
  };
}

export async function spendThisMonth() {
  const { rows: [r] } = await pool.query(
    `SELECT coalesce(sum(usd), 0)::numeric(12,6) AS usd, count(*)::int AS calls
     FROM llm_usage WHERE at >= date_trunc('month', now())`
  );
  return { usd: Number(r.usd), calls: r.calls };
}
