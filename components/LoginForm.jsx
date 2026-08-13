'use client';
import { useState } from 'react';
import { api } from '../lib/api.js';

export default function LoginForm() {
  const [mode, setMode] = useState('login'); // login | signup
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await api('/api/auth/signup', { method: 'POST', body: { name, email, password } });
      } else {
        await api('/api/auth/login', { method: 'POST', body: { email, password } });
      }
      window.location.href = '/';
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-head">
          <span className="brand-line">Jobbflo</span>
          <h1>{mode === 'login' ? 'Logga in' : 'Skapa konto'}</h1>
        </div>

        <div className="login-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => { setMode('login'); setError(null); }}>
            Logga in
          </button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} onClick={() => { setMode('signup'); setError(null); }}>
            Skapa konto
          </button>
        </div>

        <div className="login-fields">
          {mode === 'signup' && (
            <label>
              <span>Namn</span>
              <input className="txt-input" type="text" autoComplete="name" required
                value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label>
            <span>E-post</span>
            <input className="txt-input" type="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            <span>Lösenord{mode === 'signup' ? ' (minst 8 tecken)' : ''}</span>
            <input className="txt-input" type="password" minLength={mode === 'signup' ? 8 : undefined}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>

        {error && <div className="err-note" style={{ margin: '0 0 14px' }}>{error}</div>}

        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? 'Ett ögonblick…' : mode === 'login' ? 'Logga in →' : 'Skapa konto →'}
        </button>

        {mode === 'signup' && (
          <p className="login-hint">
            Har du redan data inlagd lokalt (seed)? Registrera dig med samma
            e-postadress så kopplas den befintliga profilen till kontot.
          </p>
        )}
      </form>
    </div>
  );
}
