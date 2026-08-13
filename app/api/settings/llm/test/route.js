import { NextResponse } from 'next/server';
import { PROVIDERS } from '../../../../../src/providers.js';
import { decryptSecret } from '../../../../../src/secrets.js';
import { pool } from '../../../../../src/db.js';
import { llmText } from '../../../../../src/llm.js';

export const dynamic = 'force-dynamic';

// "Testa anslutning" — one cheap round-trip against the config
// being edited, WITHOUT saving it first.
export async function POST(req) {
  const { provider, api_key, model_smart, base_url } = await req.json();
  const preset = PROVIDERS[provider];
  if (!preset) return NextResponse.json({ error: 'okänd leverantör' }, { status: 400 });

  let key = api_key?.trim();
  if (!key) {
    // testing an unchanged, already-saved key
    const { rows: [p] } = await pool.query(`SELECT llm_api_key_enc FROM profile LIMIT 1`);
    key = decryptSecret(p?.llm_api_key_enc);
  }
  if (!key) {
    // ...or the server env key, so the pre-configured provider is testable
    key = provider === 'openrouter' ? process.env.OPENROUTER_API_KEY
        : provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY
        : null;
  }
  if (!key && provider !== 'ollama') {
    return NextResponse.json({ error: 'ingen nyckel angiven' }, { status: 400 });
  }

  const config = {
    provider,
    apiKey: key || 'ollama',
    baseUrl: base_url?.trim() || preset.baseUrl,
    smart: model_smart?.trim() || preset.smart,
    fast: model_smart?.trim() || preset.fast,
  };
  if (!config.baseUrl && provider !== 'anthropic') {
    return NextResponse.json({ error: 'bas-URL krävs för den här leverantören' }, { status: 400 });
  }

  const started = Date.now();
  try {
    const reply = await llmText({
      config,
      tier: 'smart',
      maxTokens: 40,
      system: 'Svara med exakt ordet: OK',
      messages: [{ role: 'user', content: 'Svara med OK.' }],
    });
    return NextResponse.json({
      ok: true,
      ms: Date.now() - started,
      model: config.smart,
      reply: reply.slice(0, 60),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message.slice(0, 300) }, { status: 200 });
  }
}
