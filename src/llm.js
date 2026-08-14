import 'dotenv/config';
import { PROVIDERS } from './providers.js';
import { decryptSecret } from './secrets.js';

// ------------------------------------------------------------
// LLM layer. The provider is the USER's choice, stored per
// profile (bring your own key); server env vars are the
// fallback when nothing is configured in the UI.
//
// Every provider except Anthropic speaks OpenAI chat-completions,
// so there are only two transports here.
//
// Callers only use llmText()/llmJson() with a tier:
//   'bulk'  — scoring. ~90% of all tokens, so this is what decides
//             the monthly bill; a cheap model is fine here.
//   'write' — letters, revisions, replies, criteria chat. Low volume
//             but user-facing prose, so worth a good model.
//   'fast'  — reply classification (latency budget ~1s).
// 'smart' is kept as an alias for 'write' so older config still works.
//
// Splitting bulk from write is what makes a good model affordable:
// measured at ~1500 scorings vs ~150 writes per month, paying
// Sonnet rates for scoring costs 8x more than paying them for prose.
// ------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- config resolution ----------
// Cached briefly so a 20-ad scan doesn't re-query per ad.
let cached = null;
let cachedAt = 0;
const CONFIG_TTL = 30_000;

export function invalidateLlmConfig() {
  cached = null;
}

// Any provider can be configured from the environment:
//   GROQ_API_KEY / GROQ_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY, …
// LLM_PROVIDER picks which one wins when several keys are present;
// otherwise the first provider in registry order that has a key.
// Model overrides: LLM_MODEL_SMART / LLM_MODEL_FAST (or the
// provider-specific OPENROUTER_MODEL_SMART style).
function envKeyFor(id) {
  const upper = id.toUpperCase();
  const v = process.env[`${upper}_API_KEY`] || process.env[`${upper}_KEY`];
  return v?.trim() || null;
}

function envConfigFor(id) {
  const preset = PROVIDERS[id];
  if (!preset) return null;
  const apiKey = envKeyFor(id);
  if (!apiKey && !['ollama','lmstudio'].includes(id)) return null;
  const upper = id.toUpperCase();
  return {
    provider: id,
    apiKey: apiKey || 'local',
    smart: process.env[`${upper}_MODEL_SMART`] || process.env.LLM_MODEL_SMART || preset.smart,
    fast: process.env[`${upper}_MODEL_FAST`] || process.env.LLM_MODEL_FAST || preset.fast,
    // bulk (scoring) and write (prose) can point at different models —
    // both fall back to `smart`, so existing setups behave unchanged
    bulk: process.env[`${upper}_MODEL_BULK`] || process.env.LLM_MODEL_BULK || preset.bulk || null,
    write: process.env[`${upper}_MODEL_WRITE`] || process.env.LLM_MODEL_WRITE || preset.write || null,
    baseUrl: process.env[`${upper}_BASE_URL`] || preset.baseUrl,
    source: 'env',
  };
}

function envConfig() {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    const cfg = envConfigFor(explicit);
    if (cfg) return cfg;
  }
  for (const id of Object.keys(PROVIDERS)) {
    const cfg = envConfigFor(id);
    if (cfg) return cfg;
  }
  return null;
}

export async function llmConfig({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < CONFIG_TTL) return cached;

  let config = null;
  try {
    const { pool } = await import('./db.js');
    const { rows: [p] } = await pool.query(
      `SELECT llm_provider, llm_api_key_enc, llm_model_smart, llm_model_fast,
              llm_model_bulk, llm_model_write, llm_base_url
       FROM profile WHERE llm_provider IS NOT NULL LIMIT 1`
    );
    if (p?.llm_provider) {
      const preset = PROVIDERS[p.llm_provider] || {};
      const apiKey = decryptSecret(p.llm_api_key_enc);
      if (apiKey || ['ollama','lmstudio'].includes(p.llm_provider)) {
        config = {
          provider: p.llm_provider,
          apiKey: apiKey || 'local',
          smart: p.llm_model_smart || preset.smart,
          fast: p.llm_model_fast || preset.fast || p.llm_model_smart || preset.smart,
          bulk: p.llm_model_bulk || preset.bulk || null,
          write: p.llm_model_write || preset.write || null,
          baseUrl: p.llm_base_url || preset.baseUrl,
          source: 'user',
        };
      }
    }
  } catch {
    // DB unavailable (e.g. build time) — fall through to env
  }

  cached = config || envConfig();
  cachedAt = Date.now();
  return cached;
}

export async function llmAvailable() {
  return Boolean(await llmConfig());
}

// ---------- transports ----------
async function callOpenAICompatible({ baseUrl, apiKey, model, system, messages, maxTokens }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-title': 'jobbflo',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });

  // learn the real per-minute budget instead of guessing at it
  const limHeader = Number(res.headers.get('x-ratelimit-limit-tokens'));
  if (limHeader > 0) tpmLimit.set(model, limHeader);

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const err = new Error(`${res.status} ${body}`);
    err.status = res.status;
    err.transient = res.status === 429 || res.status >= 500;
    // How long to wait. The body is the most reliable source —
    // Groq answers a 429 with "Please try again in 6.938s" while
    // its x-ratelimit-reset-tokens header still reads "235ms",
    // which made an immediate retry burn the whole chain.
    const inBody = body.match(/try again in ([\d.]+)\s*(ms|s|m)?/i);
    const header = res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset-tokens');
    let waitMs = null;
    if (inBody) {
      const n = parseFloat(inBody[1]);
      waitMs = inBody[2] === 'ms' ? n : inBody[2] === 'm' ? n * 60_000 : n * 1000;
    } else if (header) {
      waitMs = /ms$/.test(header) ? parseFloat(header) : parseFloat(header) * 1000;
    }
    // never retry a rate limit faster than a second — that just
    // spends another request against the same exhausted bucket
    err.retryAfterMs = Math.min(Math.max(waitMs || 5000, 1000), 60_000);
    throw err;
  }

  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message || JSON.stringify(data.error));
    err.transient = data.error.code === 429;
    throw err;
  }
  // reasoning models put chain-of-thought in `reasoning`; only
  // `content` is usable output
  // charge the bucket with what was actually used, when reported
  const used = data.usage?.total_tokens;
  if (used) recordSpend(model, used);

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    const err = new Error(`tomt svar (finish=${data.choices?.[0]?.finish_reason})`);
    err.transient = true;
    throw err;
  }
  return text;
}

async function callAnthropic({ apiKey, model, system, messages, maxTokens }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({ model, max_tokens: maxTokens, system, messages });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// ---------- free-tier daily quota breaker ----------
// A per-day account quota is account-wide, so rotating models
// can't help — fail fast instead of hammering the API.
let quotaBlockedUntil = 0;

// An ACCOUNT-wide daily cap (OpenRouter) means no model will work,
// so fail fast. A PER-MODEL daily cap (Groq gives each model its own
// tokens-per-day budget) means the others are still fine — skip just
// that model and carry on down the chain. Conflating the two is why
// an exhausted llama-3.3-70b looked like "no credits left" when
// gpt-oss-120b still had its full budget.
const isAccountQuota = (msg) => /free-models-per-day|quota exceeded/i.test(msg);
const isModelDayQuota = (msg) => /per day|TPD|RPD|daily limit/i.test(msg);

const modelBlocked = new Map();          // model -> timestamp
const modelIsBlocked = (m) => (modelBlocked.get(m) || 0) > Date.now();

function blockModel(model, msg) {
  const m = msg.match(/try again in (?:(\d+)m)?\s*([\d.]+)s/i);
  const ms = m ? ((Number(m[1] || 0) * 60) + parseFloat(m[2])) * 1000 : 60 * 60 * 1000;
  modelBlocked.set(model, Date.now() + Math.min(ms, 24 * 60 * 60 * 1000));
  return Math.round(ms / 60000);
}

// A per-MINUTE limit is the opposite: waiting fixes it. Free tiers
// are generous per day but tight per minute (Groq: 1000 req/day but
// only 12k tokens/min), and a 20-ad scan fires ~50k tokens back to
// back — so without pacing the first scan of the day looks exactly
// like "out of credits".
const isPerMinute = (msg) =>
  /per minute|TPM|RPM|tokens per min|requests per min|rate limit reached/i.test(msg);

// Token bucket over a sliding 60s window, per model.
const spent = new Map();            // model -> [{t, tokens}]
const TPM_DEFAULT = 10_000;         // conservative; corrected from response headers
const tpmLimit = new Map();

function recordSpend(model, tokens) {
  const now = Date.now();
  const log = (spent.get(model) || []).filter((e) => now - e.t < 60_000);
  log.push({ t: now, tokens });
  spent.set(model, log);
}

async function waitForBudget(model, need) {
  const limit = tpmLimit.get(model) || TPM_DEFAULT;
  for (let i = 0; i < 12; i++) {
    const now = Date.now();
    const log = (spent.get(model) || []).filter((e) => now - e.t < 60_000);
    spent.set(model, log);
    const used = log.reduce((s, e) => s + e.tokens, 0);
    if (used + need <= limit * 0.9) return;          // 10% headroom
    // wait until the oldest entry ages out of the window
    const oldest = log[0]?.t || now;
    await sleep(Math.min(Math.max(60_000 - (now - oldest) + 250, 500), 20_000));
  }
}

const estimateTokens = (system, messages, maxTokens) =>
  Math.ceil((String(system || '').length
    + messages.reduce((s, m) => s + String(m.content || '').length, 0)) / 3.6) + (maxTokens || 0);

// ---------- public API ----------
export async function llmText({ tier = 'smart', system, messages, maxTokens = 2000, validate, config }) {
  const cfg = config || await llmConfig();
  if (!cfg) {
    throw new Error('Ingen AI-leverantör vald — gå till Profil → AI-leverantör och lägg in en nyckel.');
  }

  if (quotaBlockedUntil > Date.now()) {
    const mins = Math.ceil((quotaBlockedUntil - Date.now()) / 60000);
    throw new Error(`Dagskvoten hos ${cfg.provider} är slut (ny chans om ~${mins} min) — byt leverantör eller lägg till credits.`);
  }

  // model chain: comma-separated values allow "paid first, free fallback"
  const forTier = tier === 'fast' ? (cfg.fast || cfg.bulk || cfg.smart)
    : tier === 'bulk' ? (cfg.bulk || cfg.smart)
    : (cfg.write || cfg.smart);
  const models = String(forTier || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!models.length) throw new Error(`Ingen modell angiven för ${tier}-nivån.`);

  const need = estimateTokens(system, messages, maxTokens);
  const problems = [];
  for (let round = 0; round < 3; round++) {
    if (round > 0) await sleep(2000);
    for (const model of models) {
      if (modelIsBlocked(model)) continue;   // daily budget spent
      try {
        // pace BEFORE spending, so a burst scan doesn't trip the
        // per-minute ceiling and look like an exhausted account
        await waitForBudget(model, need);
        const text = cfg.provider === 'anthropic'
          ? await callAnthropic({ ...cfg, model, system, messages, maxTokens })
          : await callOpenAICompatible({ ...cfg, model, system, messages, maxTokens });
        return validate ? validate(text) : text;
      } catch (err) {
        if (isAccountQuota(err.message)) {
          quotaBlockedUntil = Date.now() + 30 * 60 * 1000;
          throw new Error(`Dagskvoten hos ${cfg.provider} är slut — byt leverantör i Profil, lägg till credits, eller vänta.`);
        }
        // this model is done for the day; the next one in the chain
        // has its own budget
        if (isModelDayQuota(err.message)) {
          const mins = blockModel(model, err.message);
          problems.push(`${model}: dagskvot slut (~${mins} min kvar)`);
          continue;
        }
        // per-minute limit: waiting fixes it, so wait rather than
        // burning through the rest of the chain
        if (isPerMinute(err.message) || err.status === 429) {
          recordSpend(model, need);          // assume it counted
          await sleep(Math.min(err.retryAfterMs || 5000, 60_000));
          // a per-minute limit is not the model's fault — retry it
          // rather than falling through to a weaker one
          try {
            await waitForBudget(model, need);
            const text = cfg.provider === 'anthropic'
              ? await callAnthropic({ ...cfg, model, system, messages, maxTokens })
              : await callOpenAICompatible({ ...cfg, model, system, messages, maxTokens });
            return validate ? validate(text) : text;
          } catch (retryErr) {
            problems.push(`${model} (omförsök): ${retryErr.message.slice(0, 60)}`);
          }
        }
        problems.push(`${model}: ${err.message.slice(0, 80)}`);
        if (err.status === 401 || err.status === 403) {
          throw new Error(`${cfg.provider}: nyckeln avvisades (${err.status}). Kontrollera den i Profil → AI-leverantör.`);
        }
        if (err.status && !err.transient && err.status !== 404) throw err;
      }
    }
  }
  throw new Error(`${cfg.provider}: ingen modell gav användbart svar\n  ${problems.slice(-3).join('\n  ')}`);
}

// Prompts demand bare JSON; smaller models are less disciplined,
// so strip fences and fall back to the outermost {...} span.
// Runs as a validator so unparseable output rotates to the next model.
export function parseJson(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`inte JSON: ${cleaned.slice(0, 80)}…`);
  }
}

export function llmJson(opts) {
  return llmText({ ...opts, validate: parseJson });
}
