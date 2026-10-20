import { NextResponse } from 'next/server';
import { adminProfilId, inteHittad } from '../../../../src/auth.js';
import { användarlista } from '../../../../src/admin.js';

export const dynamic = 'force-dynamic';

// Every account: what it costs and does, never what it says.
export async function GET() {
  const admin = await adminProfilId();
  if (!admin) return inteHittad();
  // du: the admin's own row, which has no Spärra button.
  const lista = (await användarlista()).map((u) => ({ ...u, du: u.profile_id === admin }));
  return NextResponse.json({ användare: lista });
}
