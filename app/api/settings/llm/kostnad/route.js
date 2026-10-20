import { NextResponse } from 'next/server';
import { aktivProfilId } from '../../../../../src/auth.js';
import { kostnadFör, REKOMMENDERADE } from '../../../../../src/kostnad.js';

export const dynamic = 'force-dynamic';

const tal = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

// What the models in the form would cost a month at the volume the user
// expects — computed for unsaved choices, so the number moves as they
// pick. Spends nothing: tokens are Jobbflo's measured averages, prices
// OpenRouter's list.
export async function POST(req) {
  await aktivProfilId();
  const b = await req.json().catch(() => ({}));
  const modeller = { fast: b.fast || null, bulk: b.bulk || null, write: b.write || null };
  return NextResponse.json({
    ...(await kostnadFör({
      provider: String(b.provider || ''),
      modeller,
      annonserPerVecka: tal(b.annonserPerVecka ?? 50, 5000),
      brevPerVecka: tal(b.brevPerVecka ?? 5, 500),
    })),
    rekommenderade: REKOMMENDERADE[b.provider] || null,
  });
}
