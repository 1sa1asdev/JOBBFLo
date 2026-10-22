import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { aktivProfilId } from '../../../../../src/auth.js';
import { PROVIDERS, ärLokal } from '../../../../../src/providers.js';
import { blockedModels } from '../../../../../src/llm.js';
import { modellista, prövaVal, NIVÅER } from '../../../../../src/modeller.js';
import { priceTable } from '../../../../../src/prices.js';

export const dynamic = 'force-dynamic';

// What the settings page may offer.
//
//   OpenRouter  the operator's list per job (src/modeller.js), each with
//               OpenRouter's price per million tokens — never the
//               provider's full catalogue
//   LM Studio / Ollama  whatever the user's own server has loaded, read
//               from the address they gave — after src/adress.js has
//               said the server may call it
export async function GET(req) {
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider');
  const baseUrl = url.searchParams.get('base_url')?.trim() || null;
  if (!PROVIDERS[provider]) return NextResponse.json({ error: 'Välj OpenRouter, LM Studio eller Ollama.' }, { status: 400 });
  const blocked = await blockedModels(await aktivProfilId());

  if (!ärLokal(provider)) {
    const [lista, priser] = await Promise.all([modellista(), priceTable()]);
    const perMiljon = (n) => (Number.isFinite(n) ? Math.round(n * 1e6 * 100) / 100 : null);
    const modeller = Object.fromEntries(NIVÅER.map((n) => [n, lista[n].map((id) => {
      const p = priser.get(id);
      return { id, in: perMiljon(p?.prompt), ut: perMiljon(p?.completion) };
    })]));
    return NextResponse.json({ modeller, blocked });
  }

  const fel = await prövaVal({ provider, baseUrl });
  if (fel) return NextResponse.json({ error: fel, models: [] }, { status: 200 });
  const bas = baseUrl || PROVIDERS[provider].baseUrl;
  try {
    const res = await fetch(`${bas.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `kunde inte hämta modeller (${res.status})`, models: [] }, { status: 200 });
    }
    const data = await res.json();
    const models = (data.data || data.models || [])
      .map((m) => ({ id: m.id || m.name }))
      .filter((m) => m.id && !/embed/i.test(m.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    return NextResponse.json({ models, blocked });
  } catch (err) {
    unstable_rethrow(err); // a 401/403 from the auth check is not this route's error
    return NextResponse.json(
      { error: `kunde inte nå ${bas} (${err.message.slice(0, 60)})`, models: [] }, { status: 200 });
  }
}
