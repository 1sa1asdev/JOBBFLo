'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ------------------------------------------------------------
// The account itself: who is signed in, and signing out. Shown only
// when the app has login at all — on one person's own machine there is
// no account to leave.
// ------------------------------------------------------------
export default function AccountSettings() {
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/api/auth/me').then(setMe).catch(() => {}); }, []);
  if (!me || me.inloggning === 'av') return null;

  async function loggaUt() {
    setBusy(true);
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  }

  return (
    <div className="field-group">
      <span className="label">Konto</span>
      <div className="llm-active">
        Inloggad som <b>{me.email}</b>{me.inloggning === 'supabase' ? ' via Google' : ''}
      </div>
      <div className="llm-acts">
        <button className="btn" type="button" onClick={loggaUt} disabled={busy}>
          {busy ? 'Loggar ut…' : 'Logga ut'}
        </button>
      </div>
    </div>
  );
}
