'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import LlmSettings from './LlmSettings.jsx';
import GmailSettings from './GmailSettings.jsx';
import AccountSettings from './AccountSettings.jsx';
import CvUpload from './CvUpload.jsx';
import CvProfilePanel, { HomePanel, BudgetPanel } from './CvProfilePanel.jsx';
import Dots from './Dots';

// onProfile: the top bar's initials follow what this panel loads and
// saves, rather than the top bar fetching the profile again on every
// open and close of the panel.
export default function ProfileView({ onClose, onProfile }) {
  const [profile, setProfile] = useState(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);

  const hämta = () => api('/api/profile')
    .then((p) => { setProfile(p); onProfile?.(p); })
    .catch((e) => setError(e.message));
  useEffect(() => { hämta(); }, []);

  function set(field, value) {
    setProfile((p) => ({ ...p, [field]: value }));
  }

  async function save() {
    try {
      const { projects, ...fields } = profile;
      await api('/api/profile', { method: 'PUT', body: fields });
      setSaved(new Date());
      onProfile?.(profile);
    } catch (e) { setError(e.message); }
  }

  if (!profile) return <div className="loading-note">{error || <>Laddar profil<Dots /></>}</div>;

  return (
    <div className="stage-view profile-view">
      <div className="profile-inner">
        <div className="profile-top">
          <div>
            <div className="idx">Profil</div>
            <h2>Din profil &amp; CV</h2>
          </div>
          <button className="close-profile" onClick={onClose}>✕ Stäng</button>
        </div>

        <CvProfilePanel
          profile={profile}
          onChanged={() => hämta()}
        />

        <HomePanel
          profile={profile}
          onChanged={() => hämta()}
        />

        <BudgetPanel />

        {/* First: the setting that gates scoring, letters and chat.
            Everything below is CV data, which is useless without it. */}
        <LlmSettings />

        {/* The account letters go out from and replies come back to. */}
        <GmailSettings />

        <AccountSettings />

        <div className="field-group">
          <span className="label">Bas-CV</span>
          <CvUpload
            scope="profile"
            current={profile.cv_text ? { filename: profile.cv_filename || 'CV', chars: profile.cv_text.length } : null}
            onDone={() => hämta()}
          />
          <details className="cv-raw">
            <summary>Visa / redigera CV-texten</summary>
            <textarea
              className="txt-area"
              style={{ minHeight: 220, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5 }}
              aria-label="CV-text"
              value={profile.cv_text || ''}
              onChange={(e) => set('cv_text', e.target.value)}
            />
          </details>
          <p className="hint">CV-texten läses vid varje matchning och när brev genereras. Stämmer något inte? Justera fritextfältet nedan — det väger tyngre.</p>
        </div>

        <div className="field-group">
          <span className="label">Kontaktuppgifter</span>
          <div className="two-col">
            <input className="txt-input" type="text" aria-label="Namn"
              value={profile.name || ''} onChange={(e) => set('name', e.target.value)} />
            <input className="txt-input" type="email" aria-label="E-post" placeholder="din@epost.se"
              value={profile.email || ''} onChange={(e) => set('email', e.target.value)} />
            <input className="txt-input" type="tel" aria-label="Telefon" placeholder="070-000 00 00"
              value={profile.phone || ''} onChange={(e) => set('phone', e.target.value)} />
            <input className="txt-input" type="text" aria-label="Ort"
              value={profile.city || ''} onChange={(e) => set('city', e.target.value)} />
          </div>
          <p className="hint">Används i mejlen som skickas via Gmail — inte i matchningen.</p>
        </div>

        <div className="field-group">
          <span className="label">Om dig — i egna ord</span>
          <textarea className="txt-area" aria-label="Om dig"
            value={profile.about_text || ''} onChange={(e) => set('about_text', e.target.value)} />
          <p className="hint">Läses vid varje matchning och används som grund i personliga brev.</p>
        </div>

        <div className="field-group">
          <span className="label">Ton i personliga brev</span>
          <textarea className="txt-area" style={{ minHeight: 62 }} aria-label="Ton"
            value={profile.tone_text || ''} onChange={(e) => set('tone_text', e.target.value)} />
        </div>

        {error && <div className="err-note" style={{ margin: '0 0 14px' }}>{error}</div>}

        <div className="save-bar">
          <button className="save" onClick={save}>Spara profil</button>
          <span className="note">
            {saved ? `Sparad ${saved.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
