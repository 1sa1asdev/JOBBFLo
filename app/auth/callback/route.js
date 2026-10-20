import { NextResponse } from 'next/server';
import { supabaseServer, kontoFörSupabase } from '../../../src/supabase.js';
import { inloggningsläge } from '../../../src/authMode.js';

export const dynamic = 'force-dynamic';

// Supabase answers in English and in its own terms; /login shows a fixed
// Swedish text per code (src/loginFel.js). The two that happen to
// people: the link was opened in another browser than the one that
// started sign-in (the PKCE verifier is a cookie there), or it is old.
function felkod(text = '') {
  if (/code verifier/i.test(text)) return 'annan-webblasare';
  if (/expired|invalid/i.test(text)) return 'lank-gammal';
  return 'okant';
}

// ------------------------------------------------------------
// Where Google (or, locally, an email link) sends the user back.
//
// The ?code is exchanged for a session (PKCE: the verifier is the cookie
// the browser stored when sign-in started, so a code lifted from a URL
// is useless elsewhere). Then the account and profile are made or
// linked, and Google's refresh token is kept — this response is the
// only time Supabase hands it over.
// ------------------------------------------------------------
export async function GET(req) {
  const url = new URL(req.url);
  const tillbaka = (kod) => {
    const mål = new URL(kod ? '/login' : '/', url.origin);
    if (kod) mål.searchParams.set('fel', kod);
    return NextResponse.redirect(mål);
  };
  if (inloggningsläge() !== 'supabase') return tillbaka('inte-paslagen');

  // Google says it refused — the user pressed Avbryt, say.
  if (url.searchParams.get('error')) return tillbaka('avbruten');
  const kod = url.searchParams.get('code');
  if (!kod) return tillbaka('okant');

  try {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.exchangeCodeForSession(kod);
    if (error || !data?.session) return tillbaka(felkod(error?.message));
    await kontoFörSupabase(data.user, { providerRefreshToken: data.session.provider_refresh_token });
    return tillbaka(null);
  } catch (err) {
    console.error('auth/callback:', err.message);
    return tillbaka(err.status === 409 ? 'konto-finns' : 'okant');
  }
}
