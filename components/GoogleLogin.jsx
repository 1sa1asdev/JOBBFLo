'use client';
import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

// ------------------------------------------------------------
// Sign in with Google, through Supabase Auth. The browser starts it so
// the PKCE verifier lands in this browser's cookies; /auth/callback
// finishes it on the server.
//
// epostlänk: an email link instead, for a local Supabase without a
// Google client (the mail shows up in Mailpit). Off in the hosted app.
// ------------------------------------------------------------
export default function GoogleLogin({ url, anonKey, epostlänk = false, fel = null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(fel);
  const [email, setEmail] = useState('');
  const [skickat, setSkickat] = useState(false);

  const klient = () => createBrowserClient(url, anonKey);
  const tillbaka = () => `${window.location.origin}/auth/callback`;

  async function google() {
    setBusy(true); setError(null);
    const { error: e } = await klient().auth.signInWithOAuth({
      provider: 'google',
      // offline: Google issues a refresh token at first consent, kept
      // for the day Gmail access goes over OAuth instead of app passwords.
      options: { redirectTo: tillbaka(), queryParams: { access_type: 'offline' } },
    });
    if (e) { setError(e.message); setBusy(false); }
  }

  async function länk(ev) {
    ev.preventDefault();
    setBusy(true); setError(null);
    const { error: e } = await klient().auth.signInWithOtp({
      email, options: { emailRedirectTo: tillbaka() },
    });
    if (e) setError(e.message); else setSkickat(true);
    setBusy(false);
  }

  return (
    <div className="login-card">
      <div className="login-head">
        <span className="brand-line">Jobbflo</span>
        <h1>Logga in</h1>
      </div>

      <div className="login-body">
        <p className="login-lede">
          Du loggar in med ditt Google-konto. Första gången skapas ett konto, och en kort guide
          hjälper dig att koppla Gmail, välja AI och ladda upp ditt CV.
        </p>

        {error && <div className="err-note">{error}</div>}

        <button className="btn primary login-submit login-google" type="button" onClick={google} disabled={busy}>
          <GoogleG />
          <span>{busy ? 'Ett ögonblick…' : 'Fortsätt med Google →'}</span>
        </button>

        {epostlänk && (
          <form onSubmit={länk} style={{ marginTop: 18 }}>
            <div className="login-fields">
              <label>
                <span>E-postlänk (bara lokalt)</span>
                <input className="txt-input" type="email" autoComplete="email" required
                  value={email} onChange={(e) => { setEmail(e.target.value); setSkickat(false); }} />
              </label>
            </div>
            <button className="btn login-submit" type="submit" disabled={busy || !email}>
              Skicka inloggningslänk
            </button>
            {skickat && <p className="login-hint">Länken är skickad. Lokalt ligger mejlet i Mailpit.</p>}
          </form>
        )}

        <p className="login-hint">
          Genom att logga in godkänner du <a href="/villkor">villkoren</a> och
          {' '}<a href="/integritet">integritetspolicyn</a>.
        </p>
      </div>
    </div>
  );
}

// Google's mark, as their sign-in guidelines ask a "continue with
// Google" button to carry. Drawn inline: no request to Google before
// the user has chosen to go there.
function GoogleG() {
  return (
    <svg className="login-g" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}
