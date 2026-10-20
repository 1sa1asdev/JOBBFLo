import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { inloggningsläge, utanInloggningTillåtet, supabaseUrl, supabaseAnonKey } from './src/authMode.js';

// ------------------------------------------------------------
// Session gate, in the three modes of src/authMode.js. Pages without a
// session redirect to /login; API calls get a 401.
//
//   supabase  the session lives in Supabase's cookies. Checked here
//             with getClaims (the JWT verified against the project's
//             keys), and refreshed into the response when it is close
//             to expiry — the one place a refreshed cookie can be
//             written for a page request.
//   lösenord  our signed cookie "uid.exp.hmac", verified with Web
//             Crypto (this runs on the edge; no Postgres, no node:crypto).
//   av        no gate — but only off production (authMode.js).
// ------------------------------------------------------------

// Reachable without a session: signing in, and the documents anyone may
// read before deciding to.
const PUBLIC = [/^\/login$/, /^\/auth\/callback$/, /^\/api\/auth\//, /^\/integritet$/, /^\/villkor$/];

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

function utestängd(req) {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'inte inloggad' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export async function middleware(req) {
  const läge = inloggningsläge();
  if (läge === 'av') {
    if (utanInloggningTillåtet()) return NextResponse.next();
    return NextResponse.json({ error: 'inloggningen är inte konfigurerad på servern' }, { status: 503 });
  }

  const { pathname } = req.nextUrl;
  const öppen = PUBLIC.some((re) => re.test(pathname));

  if (läge === 'lösenord') {
    if (öppen) return NextResponse.next();
    const token = req.cookies.get('jj_session')?.value;
    if (await verify(token, process.env.AUTH_SECRET)) return NextResponse.next();
    return utestängd(req);
  }

  // supabase: the response carries any refreshed session cookies, so it
  // is built first and handed to the client to write into.
  let svar = NextResponse.next({ request: req });
  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (lista) => {
        for (const { name, value } of lista) req.cookies.set(name, value);
        svar = NextResponse.next({ request: req });
        for (const { name, value, options } of lista) svar.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  if (öppen || data?.claims?.sub) return svar;
  return utestängd(req);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
