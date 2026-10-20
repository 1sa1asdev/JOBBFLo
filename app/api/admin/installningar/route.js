import { NextResponse } from 'next/server';
import { adminProfilId, currentUserId, inteHittad } from '../../../../src/auth.js';
import { sättPlattformsinställning } from '../../../../src/platform.js';
import { översikt } from '../../../../src/admin.js';

export const dynamic = 'force-dynamic';

// The platform's switches. Only embeddings for now: whether the worker
// keeps paying to index new ads. Already-paid vectors are kept either
// way — turning it back on must not cost twice.
export async function PATCH(req) {
  if (!(await adminProfilId())) return inteHittad();
  const { embeddings } = await req.json().catch(() => ({}));
  if (typeof embeddings !== 'boolean') {
    return NextResponse.json({ error: 'embeddings (true/false) krävs' }, { status: 400 });
  }
  await sättPlattformsinställning('embeddings_enabled', embeddings, await currentUserId());
  return NextResponse.json(await översikt());
}
