import { redirect } from 'next/navigation';
import LoginForm from '../../components/LoginForm.jsx';
import GoogleLogin from '../../components/GoogleLogin.jsx';
import { inloggningsläge, supabaseUrl, supabaseAnonKey } from '../../src/authMode.js';
import { loginFelText } from '../../src/loginFel.js';

export const metadata = { title: 'JOBBFLO — logga in' };
// The mode is the host's runtime settings, not something to bake into
// the build.
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }) {
  const läge = inloggningsläge();
  if (läge === 'av') redirect('/');
  if (läge === 'supabase') {
    const { fel } = await searchParams;
    // The URL and the anon key are public by design: RLS keeps the anon
    // key out of every table (migration 053, scripts/prove-rls.js).
    return (
      <GoogleLogin
        url={supabaseUrl()}
        anonKey={supabaseAnonKey()}
        epostlänk={process.env.SUPABASE_EPOSTLANK === '1'}
        fel={typeof fel === 'string' ? loginFelText(fel) : null}
      />
    );
  }
  return <LoginForm />;
}
