'use client';
import { useState } from 'react';
import { api } from '../lib/api.js';
import GmailSettings from './GmailSettings.jsx';
import LlmSettings from './LlmSettings.jsx';
import CvUpload from './CvUpload.jsx';

// ------------------------------------------------------------
// The first-run guide. Three things the app cannot work without, in the
// order each needs the one before:
//
//   1. Gmail     the account letters go out from and answers come
//                back to (an app password until Google approves OAuth)
//   2. AI        the user's own key and models, with what they will cost
//                before anything is spent — the CV is read by a model
//   3. CV        what every ad is judged against
//
// Every step can be skipped and done later under Profil; the guide is a
// way in, not a lock. Each step uses the same panel as Profil, so there
// is one way to connect Gmail, not two.
// ------------------------------------------------------------
const STEG = [
  {
    id: 'gmail',
    rubrik: 'Koppla din Gmail',
    text: 'Breven skickas från ditt eget Gmail-konto, och svaren läses därifrån. Jobbflo läser bara trådar som börjar med ett brev du skickat via appen, aldrig något äldre.',
  },
  {
    id: 'ai',
    rubrik: 'Välj AI och se vad det kostar',
    text: 'Jobbflo läser annonser, bedömer dem mot ditt CV och skriver brev med din egen AI-nyckel. Du betalar leverantören direkt, och kalkylen nedan visar ungefär vad dina val kostar i månaden.',
  },
  {
    id: 'cv',
    rubrik: 'Ladda upp ditt CV',
    text: 'Varje annons bedöms mot ditt CV, krav för krav, med citat från båda sidor. Det läses av modellen du valde i förra steget.',
  },
];

export default function Onboarding({ status }) {
  const [steg, setSteg] = useState(0);
  const [klara, setKlara] = useState({ gmail: status?.gmail, ai: status?.ai, cv: status?.cv });
  const [busy, setBusy] = useState(false);
  const nu = STEG[steg];
  const klar = (id) => setKlara((k) => ({ ...k, [id]: true }));

  async function avsluta() {
    setBusy(true);
    await api('/api/onboarding', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  }

  const nästa = () => (steg < STEG.length - 1 ? setSteg(steg + 1) : avsluta());

  return (
    <div className="stage-view profile-view">
      <div className="profile-inner">
        <div className="profile-top">
          <div>
            <div className="idx">Steg {steg + 1} av {STEG.length}</div>
            <h2>{steg === 0 ? `Välkommen${status?.namn ? `, ${status.namn.split(' ')[0]}` : ''}` : nu.rubrik}</h2>
          </div>
          <button className="close-profile" type="button" onClick={avsluta} disabled={busy}>
            Gör resten senare →
          </button>
        </div>

        <div className="dash-period">
          {STEG.map((s, i) => (
            <button key={s.id} type="button" className={`btn${i === steg ? ' primary' : ''}`} onClick={() => setSteg(i)}>
              {klara[s.id] ? '✓ ' : `${i + 1}. `}{s.rubrik}
            </button>
          ))}
        </div>

        {steg === 0 && <h3 style={{ margin: '0 0 6px' }}>{nu.rubrik}</h3>}
        <p className="hint">{nu.text}</p>

        {nu.id === 'gmail' && <GmailSettings onSaved={() => klar('gmail')} />}
        {nu.id === 'ai' && <LlmSettings onSaved={() => klar('ai')} />}
        {nu.id === 'cv' && (
          <div className="field-group">
            <span className="label">Bas-CV</span>
            <CvUpload scope="profile" current={null} onDone={() => klar('cv')} />
          </div>
        )}

        <div className="llm-acts" style={{ marginTop: 18 }}>
          {steg > 0 && <button className="btn" type="button" onClick={() => setSteg(steg - 1)}>← Tillbaka</button>}
          <button className="btn primary" type="button" onClick={nästa} disabled={busy}>
            {steg === STEG.length - 1
              ? (busy ? 'Öppnar…' : 'Klart, öppna Jobbflo →')
              : klara[nu.id] ? 'Nästa →' : 'Hoppa över →'}
          </button>
        </div>
      </div>
    </div>
  );
}
