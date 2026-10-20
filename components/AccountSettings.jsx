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
  const [radera, setRadera] = useState(false);
  const [bekräfta, setBekräfta] = useState('');
  const [fel, setFel] = useState(null);

  useEffect(() => { api('/api/auth/me').then(setMe).catch(() => {}); }, []);
  if (!me || (me.inloggning === 'av' && !me.admin)) return null;

  // Everything in the account, gone — the user types their own address
  // first, so no stray click can do it.
  async function raderaKonto() {
    setBusy(true); setFel(null);
    try {
      await api('/api/account', { method: 'DELETE', body: { bekräfta } });
      window.location.href = '/login';
    } catch (e) { setFel(e.message); setBusy(false); }
  }

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
          <>
            <button className="btn" type="button" onClick={loggaUt} disabled={busy}>
              {busy ? 'Ett ögonblick…' : 'Logga ut'}
            </button>
            <a className="btn" href="/api/account/export">Ladda ner min data</a>
            {!radera && (
              <button className="btn" type="button" onClick={() => setRadera(true)} disabled={busy}>
                Radera kontot…
              </button>
            )}
          </>
        )}
      </div>
      {radera && (
        <div className="llm-form" style={{ marginTop: 12 }}>
          <p className="hint" style={{ marginTop: 0 }}>
            Allt raderas: profilen, CV:t, sökningarna, kampanjerna, ansökningarna, breven och mejlen,
            och din inloggning. Det går inte att ångra. Ladda gärna ner din data först.
          </p>
          <label>
            <span>Skriv {me.email} för att bekräfta</span>
            <input className="txt-input" type="email" autoComplete="off" value={bekräfta}
              onChange={(e) => setBekräfta(e.target.value)} />
          </label>
          {fel && <div className="llm-test fail">✗ {fel}</div>}
          <div className="llm-acts">
            <button className="btn" type="button" onClick={() => { setRadera(false); setBekräfta(''); }}>Avbryt</button>
            <button className="btn primary" type="button" onClick={raderaKonto}
              disabled={busy || bekräfta.trim().toLowerCase() !== String(me.email || '').toLowerCase()}>
              {busy ? 'Raderar…' : 'Radera kontot för alltid'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
