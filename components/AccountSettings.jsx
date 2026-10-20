'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ------------------------------------------------------------
// The account itself: who is signed in, signing out, and — for the
// operator — the way to the admin page. Without login (one person on
// their own machine) only the admin link is left.
// ------------------------------------------------------------
export default function AccountSettings() {
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/api/auth/me').then(setMe).catch(() => {}); }, []);
  if (!me || (me.inloggning === 'av' && !me.admin)) return null;

  async function loggaUt() {
    setBusy(true);
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  }

  return (
    <div className="field-group">
      <span className="label">Konto</span>
      {me.inloggning !== 'av' && (
        <div className="llm-active">
          Inloggad som <b>{me.email}</b>{me.inloggning === 'supabase' ? ' via Google' : ''}
        </div>
      )}
      <div className="llm-acts">
        {me.admin && <a className="btn" href="/admin">Admin →</a>}
        {me.inloggning !== 'av' && (
          <button className="btn" type="button" onClick={loggaUt} disabled={busy}>
            {busy ? 'Loggar ut…' : 'Logga ut'}
          </button>
        )}
      </div>
    </div>
  );
}
