import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';
import { PROVIDERS } from '../../../../../src/providers.js';
import { decryptSecret } from '../../../../../src/secrets.js';
import { blockedModels } from '../../../../../src/llm.js';

export const dynamic = 'force-dynamic';

// Anthropic has no OpenAI-style /models endpoint worth listing here
const ANTHROPIC_MODELS = [
  'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1',
];

// Keep the list useful rather than exhaustive: hide models that
// can't do this job (audio/vision/embedding/guard) so the dropdown
// isn't 300 entries of noise.
const USELESS = /whisper|tts|embed|guard|moderation|rerank|vision|-vl-|image|dall-e|sora|realtime/i;

// "free" is only reported reliably by some providers. OpenRouter exposes
// pricing AND uses the `:free` id suffix; everyone else's /models returns
// no prices at all. So the flag is true when known-free, and undefined when
// unknowable — the UI must not treat "unknown" as "paid".
function isFree(m) {
  if (m.id?.includes(':free')) return true;
  if (m.pricing) {
    const prompt = Number(m.pricing.prompt);
    if (Number.isFinite(prompt)) return prompt === 0;
  }
  return undefined;
}

export async function GET(req) {
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider');
  const baseUrlParam = url.searchParams.get('base_url');
  const keyParam = url.searchParams.get('api_key');
  const preset = PROVIDERS[provider];
  if (!preset) return NextResponse.json({ error: 'okänd leverantör' }, { status: 400 });

  if (provider === 'anthropic') {
    return NextResponse.json({
      models: ANTHROPIC_MODELS.map((id) => ({ id, free: false })),
      pricing_reported: true,
      blocked: blockedModels(),
    });
  }

  const baseUrl = baseUrlParam?.trim() || preset.baseUrl;
  if (!baseUrl) return NextResponse.json({ error: 'bas-URL saknas' }, { status: 400 });

  // a key typed in the form but not yet saved wins (test-before-save flow,
  // same as /settings/llm/test); otherwise reuse the saved key or server env
  let key = keyParam?.trim() || null;
  if (!key) {
    const { rows: [p] } = await pool.query(`SELECT llm_api_key_enc FROM profile LIMIT 1`);
    key = decryptSecret(p?.llm_api_key_enc);
  }
  if (!key) {
    key = process.env[`${provider.toUpperCase()}_API_KEY`]
      || process.env[`${provider.toUpperCase()}_KEY`] || null;
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `kunde inte hämta modeller (${res.status})`, models: [] }, { status: 200 }
      );
    }
    const data = await res.json();
    const list = (data.data || data.models || [])
      .map((m) => ({
        id: m.id || m.name,
        free: isFree(m),
        context: m.context_length || m.context_window || undefined,
      }))
      .filter((m) => m.id && !USELESS.test(m.id))
      .sort((a, b) => a.id.localeCompare(b.id));

    return NextResponse.json({
      models: list,
      // does THIS provider report prices at all? if not, "free" is
      // unknowable and the UI should say so rather than filter to nothing
      pricing_reported: list.some((m) => m.free !== undefined),
      blocked: blockedModels(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `kunde inte nå ${baseUrl} (${err.message.slice(0, 60)})`, models: [] },
      { status: 200 }
    );
  }
}
