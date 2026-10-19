import { createHash } from 'node:crypto';
import { PROVIDERS } from './providers.js';
import { decryptSecret } from './secrets.js';

// ------------------------------------------------------------
// LLM layer. The provider, the key and the models are the USER's
// choice, stored on their profile — and every call says whose it is
// (profileId), so it runs on that user's key and is billed to them.
//
// There is no fallback to the server's environment. It used to be one,
// and with more than one user it means the operator silently pays for
// everyone who has not entered a key. The only platform-paid AI work is
// embedding the shared ad pool, which lives in src/embed.js with its
// own key.
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
// Per profile, cached briefly so a 20-ad scan doesn't re-query per ad.
const CONFIG_TTL = 30_000;
const configCache = new Map();     // profileId -> { cfg, at }
const keyMapCache = new Map();     // profileId -> { map, at }

export function invalidateLlmConfig(profileId) {
  if (profileId) { configCache.delete(profileId); keyMapCache.delete(profileId); return; }
  configCache.clear();
  keyMapCache.clear();
}

// Quotas and rate limits belong to a KEY, not to a model: one user
// spending their free tier must not block the same model for everyone
// else, whose keys have quotas of their own. The key itself never
// leaves this module — only a short hash of it is used as a namespace.
const nyckelId = (apiKey) => createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 12);

// Calls that do not say whose they are fall back to the only profile —
// which keeps one-off scripts working locally and refuses (owner.js)
// as soon as there is more than one. Application code always passes
// profileId; scripts/prove-profile-scope.js checks that it does.
async function ägare(profileId) {
  if (profileId) return profileId;
  const { endaProfilId } = await import('./owner.js');
  return endaProfilId();
}

export async function llmConfig({ profileId, fresh = false } = {}) {
  const id = await ägare(profileId);
  const hit = configCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < CONFIG_TTL) return hit.cfg;

  const { pool } = await import('./db.js');
  const { rows: [p] } = await pool.query(
    `SELECT llm_provider, llm_api_key_enc, llm_model_smart, llm_model_fast,
            llm_model_bulk, llm_model_write, llm_base_url
     FROM profile WHERE id = $1 AND llm_provider IS NOT NULL`, [id]
  );
  let cfg = null;
  if (p?.llm_provider) {
    const preset = PROVIDERS[p.llm_provider] || {};
    const apiKey = decryptSecret(p.llm_api_key_enc);
    if (apiKey || ['ollama', 'lmstudio'].includes(p.llm_provider)) {
      cfg = {
        provider: p.llm_provider,
        apiKey: apiKey || 'local',
        smart: p.llm_model_smart || preset.smart,
        fast: p.llm_model_fast || preset.fast || p.llm_model_smart || preset.smart,
        bulk: p.llm_model_bulk || preset.bulk || null,
        write: p.llm_model_write || preset.write || null,
        baseUrl: p.llm_base_url || preset.baseUrl,
        source: 'user',
        profileId: id,
      };
    }
  }
  configCache.set(id, { cfg, at: Date.now() });
  return cfg;
}

export async function llmAvailable({ profileId } = {}) {
  return Boolean(await llmConfig({ profileId }));
}

// Extra keys for OTHER providers in a cross-provider chain
// ("groq:llama-3.3-70b, openrouter:…") — the user's own, from their
// per-provider map. Never the server's.
async function providerKeys(profileId) {
  const hit = keyMapCache.get(profileId);
  if (hit && Date.now() - hit.at < CONFIG_TTL) return hit.map;
  const map = {};
  const { pool } = await import('./db.js');
  const { rows: [p] } = await pool.query(
    `SELECT llm_keys_enc FROM profile WHERE id = $1`, [profileId]);
  for (const [prov, enc] of Object.entries(p?.llm_keys_enc || {})) {
    const k = decryptSecret(enc);
    if (k) map[prov] = k;
  }
  keyMapCache.set(profileId, { map, at: Date.now() });
  return map;
}

export async function configFor(provider, primary) {
  const preset = PROVIDERS[provider];
  if (!preset) return null;
  if (provider === primary?.provider) return primary;

  const isLocal = ['ollama', 'lmstudio'].includes(provider);
  // A config handed in directly (the "test connection" button) has no
  // profile behind it, and so no other keys to borrow.
  const key = primary?.profileId ? (await providerKeys(primary.profileId))[provider] : null;
  if (!key && !isLocal) return null;

  return {
    provider,
    apiKey: key || 'local',
    baseUrl: preset.baseUrl,
  };
}

// ---------- transports ----------
async function callOpenAICompatible({ baseUrl, apiKey, model, system, messages, maxTokens,
                                     provider, tier, hink, profileId }) {
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
  if (limHeader > 0) tpmLimit.set(hink, limHeader);

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

    // OpenRouter reports the daily reset as a unix-ms timestamp, in a
    // header AND mirrored inside the error body — so a spent free tier
    // can say exactly when it returns instead of guessing an hour.
    const resetHeader = Number(res.headers.get('x-ratelimit-reset'));
    const resetInBody = Number(body.match(/"X-RateLimit-Reset":"?(\d{10,})"?/)?.[1]);
    const resetAt = resetHeader || resetInBody;
    if (resetAt > Date.now()) err.resetAt = resetAt;
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
  if (used) recordSpend(hink, used);

  // Metered as well as rate-limited. recordSpend keeps a 60-second
  // window in memory for the breaker; this writes the call down so the
  // monthly budget has something real to read. Deliberately not awaited
  // — the user's answer must not wait on bookkeeping — and it swallows
  // its own errors for the same reason.
  import('./prices.js')
    .then(({ recordUsage }) => recordUsage({
      provider, model, tier, profileId,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: used,
    }))
    .catch(() => {});

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
// An ACCOUNT-wide daily cap (OpenRouter) means no model will work,
// so fail fast. A PER-MODEL daily cap (Groq gives each model its own
// tokens-per-day budget) means the others are still fine — skip just
// that model and carry on down the chain. Conflating the two is why
// an exhausted llama-3.3-70b looked like "no credits left" when
// gpt-oss-120b still had its full budget.
const isAccountQuota = (msg) => /free-models-per-day|quota exceeded/i.test(msg);
const isModelDayQuota = (msg) => /per day|TPD|RPD|daily limit/i.test(msg);

// Keyed "<key hash>|provider:model" and "<key hash>|provider": a quota is
// spent on one key, and every other key's quota is untouched.
const modelBlocked = new Map();
const providerBlocked = new Map();
const modelIsBlocked = (k) => (modelBlocked.get(k) || 0) > Date.now();
const providerIsBlocked = (p) => (providerBlocked.get(p) || 0) > Date.now();

// So the settings UI can show what is spent and when it comes back —
// for this user's keys only.
export async function blockedModels(profileId) {
  const cfg = await llmConfig({ profileId });
  if (!cfg) return {};
  const id = await ägare(profileId);
  const nycklar = new Set([nyckelId(cfg.apiKey), ...Object.values(await providerKeys(id)).map(nyckelId)]);
  const now = Date.now();
  const mins = (until) => Math.ceil((until - now) / 60000);
  const egna = (map) => [...map.entries()]
    .filter(([k, u]) => u > now && nycklar.has(k.split('|')[0]))
    .map(([k, u]) => [k.split('|')[1], mins(u)]);
  return {
    ...Object.fromEntries(egna(modelBlocked)),
    ...Object.fromEntries(egna(providerBlocked).map(([p, m]) => [`${p}:*`, m])),
  };
}

// Reset timing is knowable — both providers say so, just differently:
//   Groq        429 body: "Please try again in 48m56.736s"
//   OpenRouter  X-RateLimit-Reset header: unix ms (UTC midnight)
// Falling back to an hour is only for providers that say nothing.
function resetFromError(err) {
  if (err?.resetAt) return err.resetAt;
  const m = String(err?.message || '').match(/try again in (?:(\d+)m)?\s*([\d.]+)s/i);
  if (m) return Date.now() + (((Number(m[1] || 0) * 60) + parseFloat(m[2])) * 1000);
  return Date.now() + 60 * 60 * 1000;
}

function blockModel(nyckel, provider, model, err) {
  const until = Math.min(resetFromError(err), Date.now() + 24 * 60 * 60 * 1000);
  modelBlocked.set(`${nyckel}|${provider}:${model}`, until);
  return Math.max(1, Math.round((until - Date.now()) / 60000));
}

function blockProvider(nyckel, provider, err) {
  const until = Math.min(resetFromError(err), Date.now() + 24 * 60 * 60 * 1000);
  providerBlocked.set(`${nyckel}|${provider}`, until);
  return Math.max(1, Math.round((until - Date.now()) / 60000));
}

// A per-MINUTE limit is the opposite: waiting fixes it. Free tiers
// are generous per day but tight per minute (Groq: 1000 req/day but
// only 12k tokens/min), and a 20-ad scan fires ~50k tokens back to
// back — so without pacing the first scan of the day looks exactly
// like "out of credits".
const isPerMinute = (msg) =>
  /per minute|TPM|RPM|tokens per min|requests per min|rate limit reached/i.test(msg);

// Token bucket over a sliding 60s window, per key and model.
const spent = new Map();            // "<key hash>|provider:model" -> [{t, tokens}]
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
// `onModel` is called with "provider:model" for whichever entry in the
// chain actually answered. Callers that persist a result need it: a CV
// profile built by a weak fallback should be rebuilt, not trusted, and
// without this the chain silently hides which model produced what.
export async function llmText({ profileId, tier = 'smart', system, messages, maxTokens = 2000, validate, config, onModel }) {
  const cfg = config || await llmConfig({ profileId });
  if (!cfg) {
    throw new Error('Ingen AI-leverantör vald — gå till Profil → AI-leverantör och lägg in en nyckel.');
  }
  const ägarId = cfg.profileId || null;

  // model chain: comma-separated values allow "paid first, free fallback"
  const forTier = tier === 'fast' ? (cfg.fast || cfg.bulk || cfg.smart)
    : tier === 'bulk' ? (cfg.bulk || cfg.smart)
    : (cfg.write || cfg.smart);
  // A chain entry may name its own provider ("groq:llama-3.3-70b"),
  // so one tier can fall from Groq to OpenRouter to the local model —
  // each has its own quota and its own reset clock.
  const entries = String(forTier || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((raw) => {
      const i = raw.indexOf(':');
      const maybe = i > 0 ? raw.slice(0, i) : null;
      return PROVIDERS[maybe]
        ? { provider: maybe, model: raw.slice(i + 1) }
        : { provider: cfg.provider, model: raw };
    });
  if (!entries.length) throw new Error(`Ingen modell angiven för ${tier}-nivån.`);

  const need = estimateTokens(system, messages, maxTokens);
  const problems = [];
  for (let round = 0; round < 3; round++) {
    if (round > 0) await sleep(2000);
    for (const { provider, model } of entries) {
      const pcfg = await configFor(provider, cfg);
      if (!pcfg) { problems.push(`${provider}: ingen nyckel`); continue; }
      const nyckel = nyckelId(pcfg.apiKey);
      const hink = `${nyckel}|${provider}:${model}`;
      if (providerIsBlocked(`${nyckel}|${provider}`)) continue;  // this key's account cap
      if (modelIsBlocked(hink)) continue;                         // this key's daily budget for the model
      const anrop = { ...pcfg, model, system, messages, maxTokens, provider, tier, hink, profileId: ägarId };
      try {
        // pace BEFORE spending, so a burst scan doesn't trip the
        // per-minute ceiling and look like an exhausted account.
        // Local servers have no per-minute quota — pacing just sleeps
        // between ads, so skip it there entirely.
        if (!['ollama', 'lmstudio'].includes(provider)) {
          await waitForBudget(hink, need);
        }
        const text = provider === 'anthropic'
          ? await callAnthropic(anrop)
          : await callOpenAICompatible(anrop);
        onModel?.(`${provider}:${model}`);
        return validate ? validate(text) : text;
      } catch (err) {
        // local servers have no quotas — never block, never retry-chain,
        // just report the failure and move on
        if (provider === 'ollama' || provider === 'lmstudio') {
          problems.push(`${model}: ${err.message.slice(0, 80)}`);
          continue;
        }
        // account-wide cap: this PROVIDER is done, but the next
        // entry may live on a different one, so keep going
        if (isAccountQuota(err.message)) {
          const mins = blockProvider(nyckel, provider, err);
          problems.push(`${provider}: dagskvot slut (~${mins} min)`);
          continue;
        }
        // this model is done for the day; the next one in the chain
        // has its own budget
        if (isModelDayQuota(err.message)) {
          const mins = blockModel(nyckel, provider, model, err);
          problems.push(`${provider}:${model}: dagskvot slut (~${mins} min kvar)`);
          continue;
        }
        // per-minute limit: waiting fixes it, so wait rather than
        // burning through the rest of the chain
        if (isPerMinute(err.message) || err.status === 429) {
          recordSpend(hink, need);   // assume it counted
          await sleep(Math.min(err.retryAfterMs || 5000, 60_000));
          // a per-minute limit is not the model's fault — retry it
          // rather than falling through to a weaker one
          try {
            await waitForBudget(hink, need);
            const text = provider === 'anthropic'
              ? await callAnthropic(anrop)
              : await callOpenAICompatible(anrop);
            onModel?.(`${provider}:${model}`);
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
