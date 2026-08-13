import 'dotenv/config';

// ------------------------------------------------------------
// LLM layer. Provider-pluggable:
//   OPENROUTER_API_KEY set  → OpenRouter (default: free models)
//   else ANTHROPIC_API_KEY  → Anthropic direct
// Callers only ever use llmText()/llmJson() with a tier:
//   'smart' — scoring, letters, criteria chat (nuance)
//   'fast'  — reply classification (latency budget ~1s)
//
// Free models are aggressively rate-limited upstream, so each
// tier is a CHAIN: on 429/404/5xx we fall through to the next
// model, and only retry-with-backoff if the whole chain is busy.
// ------------------------------------------------------------

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Chains chosen by probing openrouter.ai/api/v1/models for JSON
// compliance + latency. OpenRouter rotates its :free catalogue —
// if these all 404, re-probe and override via .env (comma-separated).
const DEFAULT_SMART = [
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-nano-9b-v2:free',
];
const DEFAULT_FAST = [
  'nvidia/nemotron-nano-9b-v2:free',
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
  'liquid/lfm-2.5-2.6b:free',
];

const chain = (envVar, fallback) =>
  (process.env[envVar]?.split(',').map((s) => s.trim()).filter(Boolean).length
    ? process.env[envVar].split(',').map((s) => s.trim()).filter(Boolean)
    : fallback);

const ANT_SMART = 'claude-sonnet-4-6';
const ANT_FAST = 'claude-haiku-4-5';

export function llmAvailable() {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The free tier has a per-DAY account quota. That error is
// account-wide, so rotating models can't help — trying is pure
// waste (the worker would hammer 5 models × 2 rounds per ad).
// Trip a breaker and fail fast until it resets.
let quotaBlockedUntil = 0;
const isDailyQuota = (msg) => /free-models-per-day|per-day|daily limit/i.test(msg);
export function quotaBlocked() {
  return quotaBlockedUntil > Date.now();
}

async function callOpenRouter(model, { system, messages, maxTokens }) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
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
    // 429 = busy now (worth retrying), 404 = gone from the free tier
    err.transient = res.status === 429 || res.status >= 500;
    throw err;
  }

  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message || JSON.stringify(data.error));
    err.transient = data.error.code === 429;
    throw err;
  }
  // reasoning models put chain-of-thought in `reasoning` and the
  // real answer in `content` — only `content` is usable output
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    const err = new Error(`tomt svar (finish=${data.choices?.[0]?.finish_reason})`);
    err.transient = true; // try the next model in the chain
    throw err;
  }
  return text;
}

async function completeOpenRouter({ tier, system, messages, maxTokens, validate }) {
  const models = tier === 'fast'
    ? chain('OPENROUTER_MODEL_FAST', DEFAULT_FAST)
    : chain('OPENROUTER_MODEL_SMART', DEFAULT_SMART);

  if (quotaBlocked()) {
    const mins = Math.ceil((quotaBlockedUntil - Date.now()) / 60000);
    throw new Error(`OpenRouter: dagskvoten för gratismodeller är slut (försök igen om ~${mins} min, eller lägg till credits på openrouter.ai)`);
  }

  const problems = [];
  // two passes: try every model, then back off and try again.
  // `validate` runs here so a model that won't produce the shape
  // we need (common with free reasoning models) is skipped like
  // any other failure instead of poisoning the caller.
  for (let round = 0; round < 2; round++) {
    if (round > 0) await sleep(4000);
    for (const model of models) {
      try {
        const text = await callOpenRouter(model, { system, messages, maxTokens });
        return validate ? validate(text) : text;
      } catch (err) {
        if (isDailyQuota(err.message)) {
          quotaBlockedUntil = Date.now() + 30 * 60 * 1000; // re-probe in 30 min
          throw new Error('OpenRouter: dagskvoten för gratismodeller är slut — lägg till credits på openrouter.ai, sätt ANTHROPIC_API_KEY, eller vänta tills kvoten återställs');
        }
        problems.push(`${model}: ${err.message.slice(0, 80)}`);
        if (err.status && !err.transient && err.status !== 404) throw err; // real API error
      }
    }
  }
  throw new Error(`OpenRouter: ingen modell gav användbart svar\n  ${problems.slice(-4).join('\n  ')}`);
}

async function completeAnthropic({ tier, system, messages, maxTokens }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: tier === 'fast' ? ANT_FAST : ANT_SMART,
    max_tokens: maxTokens,
    system,
    messages,
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export async function llmText({ tier = 'smart', system, messages, maxTokens = 2000, validate }) {
  if (process.env.OPENROUTER_API_KEY) {
    return completeOpenRouter({ tier, system, messages, maxTokens, validate });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const text = await completeAnthropic({ tier, system, messages, maxTokens });
    return validate ? validate(text) : text;
  }
  throw new Error('ingen AI-nyckel — sätt OPENROUTER_API_KEY (gratis) eller ANTHROPIC_API_KEY i .env');
}

// The prompts demand bare JSON; free models are less disciplined,
// so strip fences and fall back to the outermost {...} span.
// Passed as a validator so unparseable output rotates to the next model.
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
