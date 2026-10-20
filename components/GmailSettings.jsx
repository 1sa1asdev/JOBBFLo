'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate } from '../lib/api.js';
import Dots from './Dots';

// ------------------------------------------------------------
// The user's Gmail connection — the account letters go out from and
// replies come back to. Until Google approves Gmail access over OAuth,
// that takes an app password, and the commonest place people get stuck
// is that Google hides the app-password page entirely until 2-step
// verification is on. So that is said first, before the link.
//
// The password is tested against both sending and reading before it is
// saved, and never shown again afterwards — not even masked.
// ------------------------------------------------------------
// onSaved: the onboarding guide moves on once a password passes.
export default function GmailSettings({ onSaved } = {}) {
  const [data, setData] = useState(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api('/api/settings/gmail').then(setData).catch((e) => setError(e.message));
  }, []);

  async function save() {
    setBusy('save'); setError(null); setSaved(false);
    try {
      setData(await api('/api/settings/gmail', { method: 'PUT', body: { password } }));
      setPassword('');
      setSaved(true);
      onSaved?.();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function disconnect() {
    setBusy('clear'); setError(null); setSaved(false);
    try { setData(await api('/api/settings/gmail', { method: 'DELETE' })); } catch (e) { setError(e.message); }
    setBusy(null);
  }

  if (!data) return <div className="loading-note">{error || <>Laddar<Dots /></>}</div>;

  return (
    <div className="field-group">
      <span className="label">Gmail</span>

      <div className="llm-active">
        {data.connected
          ? <>Kopplat: <b>{data.address}</b>{data.verified_at && <> — verifierat {fmtDate(data.verified_at)}</>}</>
          : <>Inte kopplat. Brev kan inte skickas och svar kan inte läsas förrän Gmail är kopplat.</>}
      </div>

      {/* The worker stopped reading this mailbox, and this is the only
          place the user would find out why. */}
      {data.error && (
        <div className="llm-test fail">
          ✗ Svar läses inte just nu: {data.error}
          {data.error_at && <> ({fmtDate(data.error_at)})</>}
        </div>
      )}

      <div className="llm-form">
        <ol className="hint" style={{ margin: '0 0 14px', paddingLeft: 18 }}>
          <li>
            Slå på <b>tvåstegsverifiering</b> på ditt Google-konto. Utan den visar Google inte
            sidan för applösenord alls.{' '}
            <a className="llm-link" href="https://myaccount.google.com/signinoptions/two-step-verification"
              target="_blank" rel="noreferrer">Tvåstegsverifiering →</a>
          </li>
          <li>
            Skapa ett applösenord, döp det till <i>Jobbflo</i>, och kopiera de 16 tecknen.{' '}
            <a className="llm-link" href="https://myaccount.google.com/apppasswords"
              target="_blank" rel="noreferrer">Skapa applösenord →</a>
          </li>
          <li>Klistra in det här. Det testas mot både sändning och läsning innan det sparas.</li>
        </ol>

        <label>
          <span>Applösenord för {data.address || 'ditt konto'}</span>
          <input
            className="txt-input" type="password" autoComplete="off"
            placeholder={data.connected ? 'sparat — klistra in ett nytt för att byta' : 'abcd efgh ijkl mnop'}
            value={password} onChange={(e) => { setPassword(e.target.value); setSaved(false); }}
          />
        </label>

        <p className="hint">
          Fungerar inte med jobb- eller skolkonton där administratören stängt av applösenord,
          eller med Googles Avancerat skydd — använd då ett privat Gmail-konto.
        </p>

        {error && <div className="llm-test fail">✗ {error}</div>}

        <div className="llm-acts">
          <button className="btn primary" type="button" onClick={save} disabled={busy || !password.trim()}>
            {busy === 'save' ? 'Testar…' : 'Testa och spara'}
          </button>
          {data.connected && (
            <button className="btn" type="button" onClick={disconnect} disabled={busy}>Koppla bort</button>
          )}
          {saved && <span className="gate-status">✓ Sändning och läsning fungerar — sparat</span>}
        </div>
      </div>
    </div>
  );
}
