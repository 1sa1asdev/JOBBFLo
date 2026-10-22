import { redirect } from 'next/navigation';
import Landing from '../../components/Landing.jsx';
import LoginForm from '../../components/LoginForm.jsx';
import GoogleLogin from '../../components/GoogleLogin.jsx';
import { inloggningsläge, supabaseUrl, supabaseAnonKey } from '../../src/authMode.js';
import { loginFelText } from '../../src/loginFel.js';

export const metadata = {
  title: 'Jobbflo — sök jobb med en plan',
  description: 'Jobbflo bedömer annonserna i Platsbanken mot ditt CV krav för krav, skriver brev du godkänner och håller koll på svaren.',
};
// The mode is the host's runtime settings, not something to bake into
// the build.
export const dynamic = 'force-dynamic';

// Every visitor without a session lands here (middleware.js), so this is
// the front page as well as the sign-in: what Jobbflo does, and the way in.
export default async function LoginPage({ searchParams }) {
  const läge = inloggningsläge();
  if (läge === 'av') redirect('/');
  if (läge === 'supabase') {
    const { fel } = await searchParams;
    // The URL and the anon key are public by design: RLS keeps the anon
    // key out of every table (migration 053, scripts/prove-rls.js).
    return (
      <Landing inloggning={(
        <GoogleLogin
          url={supabaseUrl()}
          anonKey={supabaseAnonKey()}
          epostlänk={process.env.SUPABASE_EPOSTLANK === '1'}
          fel={typeof fel === 'string' ? loginFelText(fel) : null}
        />
      )} />
    );
  }
  return <Landing inloggning={<LoginForm />} />;
}
