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
//   'smart' — scoring, letters, criteria chat (nuance)
//   'fast'  — reply classification (latency budget ~1s)
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
  if (!apiKey && id !== 'ollama') return null;
  const upper = id.toUpperCase();
  return {
    provider: id,
    apiKey: apiKey || 'ollama',
    smart: process.env[`${upper}_MODEL_SMART`] || process.env.LLM_MODEL_SMART || preset.smart,
    fast: process.env[`${upper}_MODEL_FAST`] || process.env.LLM_MODEL_FAST || preset.fast,
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
      `SELECT llm_provider, llm_api_key_enc, llm_model_smart, llm_model_fast, llm_base_url
       FROM profile WHERE llm_provider IS NOT NULL LIMIT 1`
    );
    if (p?.llm_provider) {
      const preset = PROVIDERS[p.llm_provider] || {};
      const apiKey = decryptSecret(p.llm_api_key_enc);
      if (apiKey || p.llm_provider === 'ollama') {
        config = {
          provider: p.llm_provider,
          apiKey: apiKey || 'ollama',
          smart: p.llm_model_smart || preset.smart,
          fast: p.llm_model_fast || preset.fast || p.llm_model_smart || preset.smart,
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

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const err = new Error(`${res.status} ${body}`);
    err.status = res.status;
    err.transient = res.status === 429 || res.status >= 500;
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
const isDailyQuota = (msg) => /free-models-per-day|per-day|daily limit|quota exceeded/i.test(msg);

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
  const models = String(tier === 'fast' ? cfg.fast : cfg.smart)
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!models.length) throw new Error(`Ingen modell angiven för ${tier}-nivån.`);

  const problems = [];
  for (let round = 0; round < 2; round++) {
    if (round > 0) await sleep(3000);
    for (const model of models) {
      try {
        const text = cfg.provider === 'anthropic'
          ? await callAnthropic({ ...cfg, model, system, messages, maxTokens })
          : await callOpenAICompatible({ ...cfg, model, system, messages, maxTokens });
        return validate ? validate(text) : text;
      } catch (err) {
        if (isDailyQuota(err.message)) {
          quotaBlockedUntil = Date.now() + 30 * 60 * 1000;
          throw new Error(`Dagskvoten hos ${cfg.provider} är slut — byt leverantör i Profil, lägg till credits, eller vänta.`);
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
