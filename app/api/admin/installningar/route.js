import { NextResponse } from 'next/server';
import { adminProfilId, currentUserId, inteHittad } from '../../../../src/auth.js';
import { sättPlattformsinställning } from '../../../../src/platform.js';
import { översikt } from '../../../../src/admin.js';
import { normaliseraLista, glömModellista, NIVÅER, NIVÅNAMN } from '../../../../src/modeller.js';
import { priceTable } from '../../../../src/prices.js';
import { invalidateLlmConfig } from '../../../../src/llm.js';

export const dynamic = 'force-dynamic';

// The platform's switches:
//   embeddings  whether the worker keeps paying to index new ads.
//               Already-paid vectors are kept either way — turning it
//               back on must not cost twice.
//   modeller    the OpenRouter models users may pick, per job
//               (src/modeller.js). Every job needs at least one, and
//               every id must exist at OpenRouter — a typo would leave
//               users on a model that answers every call with an error.
export async function PATCH(req) {
  if (!(await adminProfilId())) return inteHittad();
  const body = await req.json().catch(() => ({}));
  const vem = await currentUserId();

  if ('embeddings' in body) {
    if (typeof body.embeddings !== 'boolean') {
      return NextResponse.json({ error: 'embeddings (true/false) krävs' }, { status: 400 });
    }
    await sättPlattformsinställning('embeddings_enabled', body.embeddings, vem);
  } else if ('modeller' in body) {
    const lista = normaliseraLista(body.modeller);
    if (!lista) return NextResponse.json({ error: 'modeller ska vara en lista per uppgift' }, { status: 400 });
    const tom = NIVÅER.find((n) => !lista[n].length);
    if (tom) return NextResponse.json({ error: `${NIVÅNAMN[tom]} behöver minst en modell` }, { status: 400 });
    const katalog = await priceTable();
    if (!katalog.size) {
      return NextResponse.json({ error: 'OpenRouter svarar inte just nu, så modellerna går inte att kontrollera. Försök igen om en stund.' }, { status: 503 });
    }
    const okänd = NIVÅER.flatMap((n) => lista[n]).find((id) => !katalog.has(id));
    if (okänd) return NextResponse.json({ error: `${okänd} finns inte hos OpenRouter` }, { status: 400 });
    await sättPlattformsinställning('llm_modeller', lista, vem);
    glömModellista();
    invalidateLlmConfig();
  } else {
    return NextResponse.json({ error: 'embeddings eller modeller krävs' }, { status: 400 });
  }
  return NextResponse.json(await översikt());
}
