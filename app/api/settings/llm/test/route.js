import { NextResponse } from 'next/server';
import { aktivProfilId } from '../../../../../src/auth.js';
import { PROVIDERS, ärLokal } from '../../../../../src/providers.js';
import { decryptSecret } from '../../../../../src/secrets.js';
import { pool } from '../../../../../src/db.js';
import { llmText } from '../../../../../src/llm.js';
import { prövaVal } from '../../../../../src/modeller.js';
import { UPPGIFT } from '../../../../../src/uppgifter.js';

export const dynamic = 'force-dynamic';

// "Testa anslutning" — one cheap round-trip against the config
// being edited, WITHOUT saving it first. The same rules as saving
// (src/modeller.js): a test is still a call the server makes.
export async function POST(req) {
  const { provider, api_key, model_smart, base_url } = await req.json();
  const lokal = ärLokal(provider);
  const fel = await prövaVal({
    provider, modeller: { smart: model_smart }, baseUrl: (lokal && base_url?.trim()) || null,
  });
  if (fel) return NextResponse.json({ error: fel }, { status: 400 });
  const preset = PROVIDERS[provider];

  let key = api_key?.trim();
  if (!key) {
    // testing an unchanged, already-saved key
    const { rows: [p] } = await pool.query(
      `SELECT llm_api_key_enc FROM profile WHERE id = $1`, [await aktivProfilId()]);
    key = decryptSecret(p?.llm_api_key_enc);
  }
  if (!key && !lokal) {
    return NextResponse.json({ error: 'ingen nyckel angiven' }, { status: 400 });
  }

  const config = {
    provider,
    apiKey: key || 'local',
    baseUrl: (lokal && base_url?.trim()) || preset.baseUrl,
    smart: model_smart?.trim() || preset.smart,
    fast: model_smart?.trim() || preset.fast,
  };

  const started = Date.now();
  try {
    const reply = await llmText({
      config,
      uppgift: UPPGIFT.TEST,
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
