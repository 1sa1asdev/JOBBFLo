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
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-head">
          <span className="brand-line">Jobbflo</span>
          <h1>Logga in</h1>
        </div>

        <p className="login-hint" style={{ marginTop: 0 }}>
          Du loggar in med ditt Google-konto. Har du inget konto skapas ett när du loggar in första gången.
        </p>

        {error && <div className="err-note" style={{ margin: '0 0 14px' }}>{error}</div>}

        <button className="btn primary login-submit" type="button" onClick={google} disabled={busy}>
          {busy ? 'Ett ögonblick…' : 'Fortsätt med Google →'}
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
