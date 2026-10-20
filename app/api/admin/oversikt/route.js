import { NextResponse } from 'next/server';
import { adminProfilId, inteHittad } from '../../../../src/auth.js';
import { översikt } from '../../../../src/admin.js';

export const dynamic = 'force-dynamic';

// The platform at a glance — its key, its spend, the pool, the worker.
// 404 for anyone but the operator: the admin pages do not announce
// themselves.
export async function GET() {
  if (!(await adminProfilId())) return inteHittad();
  return NextResponse.json(await översikt());
}
