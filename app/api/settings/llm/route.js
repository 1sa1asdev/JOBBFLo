import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { PROVIDERS, providerList } from '../../../../src/providers.js';
import { encryptSecret, decryptSecret, maskSecret } from '../../../../src/secrets.js';
import { invalidateLlmConfig, llmConfig, blockedModels } from '../../../../src/llm.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { rows: [p] } = await pool.query(
    `SELECT id, llm_provider, llm_api_key_enc, llm_model_smart, llm_model_fast,
            llm_model_bulk, llm_model_write, llm_base_url
     FROM profile LIMIT 1`
  );
  const active = await llmConfig({ fresh: true });

  return NextResponse.json({
    providers: providerList(),
    // which models are spent for today (model -> minutes left). The client
    // polls this so the dropdown can mark models that ran out of tokens.
    blocked: blockedModels(),
    current: {
      provider: p?.llm_provider || null,
      model_smart: p?.llm_model_smart || null,
      model_fast: p?.llm_model_fast || null,
      model_bulk: p?.llm_model_bulk || null,
      model_write: p?.llm_model_write || null,
      base_url: p?.llm_base_url || null,
      // never return the key itself
      key_masked: maskSecret(decryptSecret(p?.llm_api_key_enc)),
    },
    // what's actually in use right now (may come from server env)
    active: active ? { provider: active.provider, smart: active.smart, fast: active.fast,
                       bulk: active.bulk, write: active.write, source: active.source } : null,
  });
}

export async function PUT(req) {
  const { provider, api_key, model_smart, model_fast, model_bulk, model_write, base_url } = await req.json();

  if (provider && !PROVIDERS[provider]) {
    return NextResponse.json({ error: 'okänd leverantör' }, { status: 400 });
  }

  const { rows: [p] } = await pool.query(`SELECT id, llm_api_key_enc FROM profile LIMIT 1`);
  if (!p) return NextResponse.json({ error: 'ingen profil' }, { status: 404 });

  // empty api_key means "keep the stored one"
  const keyEnc = api_key?.trim() ? encryptSecret(api_key.trim()) : p.llm_api_key_enc;

  await pool.query(
    `UPDATE profile SET llm_provider = $2, llm_api_key_enc = $3,
       llm_model_smart = $4, llm_model_fast = $5, llm_base_url = $6,
       llm_model_bulk = $7, llm_model_write = $8, updated_at = now()
     WHERE id = $1`,
    [p.id, provider || null, keyEnc,
     model_smart?.trim() || null, model_fast?.trim() || null, base_url?.trim() || null,
     model_bulk?.trim() || null, model_write?.trim() || null]
  );

  invalidateLlmConfig();
  const active = await llmConfig({ fresh: true });
  return NextResponse.json({
    ok: true,
    active: active ? { provider: active.provider, smart: active.smart, fast: active.fast,
                       bulk: active.bulk, write: active.write, source: active.source } : null,
  });
}

// clear configuration (fall back to server env)
export async function DELETE() {
  await pool.query(
    `UPDATE profile SET llm_provider = NULL, llm_api_key_enc = NULL,
       llm_model_smart = NULL, llm_model_fast = NULL, llm_base_url = NULL,
       llm_model_bulk = NULL, llm_model_write = NULL`
  );
  invalidateLlmConfig();
  return NextResponse.json({ ok: true });
}
