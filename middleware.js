import { NextResponse } from 'next/server';

// ------------------------------------------------------------
// Session gate. Runs on the edge runtime, so the cookie is
// verified with Web Crypto here (no Postgres, no node:crypto) —
// the token format "uid.exp.hmac" is produced by src/auth.js.
// Pages redirect to /login; API calls get a 401.
// ------------------------------------------------------------

const PUBLIC = [/^\/login$/, /^\/api\/auth\//];

async function verify(token, secret) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [uid, exp, sig] = parts;
  if (Number(exp) < Date.now()) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${uid}.${exp}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function middleware(req) {
  // LOCAL-ONLY MODE: accounts are opt-in. Without AUTH_SECRET the
  // whole gate is off — set it (deployment) and login is required.
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();

  const token = req.cookies.get('jj_session')?.value;
  if (await verify(token, secret)) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'inte inloggad' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
