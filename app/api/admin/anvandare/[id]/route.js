import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { adminProfilId, inteHittad } from '../../../../../src/auth.js';
import { sättSpärr } from '../../../../../src/admin.js';

export const dynamic = 'force-dynamic';

// Block or unblock an account (src/admin.js sättSpärr).
export async function PATCH(req, { params }) {
  const admin = await adminProfilId();
  if (!admin) return inteHittad();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return inteHittad('kontot finns inte');
  const { spärrad } = await req.json().catch(() => ({}));
  if (typeof spärrad !== 'boolean') {
    return NextResponse.json({ error: 'spärrad (true/false) krävs' }, { status: 400 });
  }
  try {
    const u = await sättSpärr(id, spärrad, { av: admin });
    return NextResponse.json({ id: u.id, spärrad: Boolean(u.disabled_at) });
  } catch (err) {
    unstable_rethrow(err); // a 401/403 from the auth check is not this route's error
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
