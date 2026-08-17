'use client';
import { useState } from 'react';
import { api } from '../lib/api.js';
import Dots from './Dots';

// ------------------------------------------------------------
// What the app believes about you, and where it read it.
//
// This is the single reading of your CV that every score and every
// letter is built on. Showing it — with the exact line each fact came
// from — is the point: a misreading here propagates to a thousand
// downstream calls, so it is worth one look. Correct it once instead
// of correcting a thousand outputs.
//
// A fact whose evidence is not verbatim in the CV is flagged rather
// than hidden. That is the same rule the ad quotes obey (CLAUDE.md #5)
// and the reason it can be checked at all.
// ------------------------------------------------------------
// Where the user travels from. Resolved against the ad pool's own
// coordinates rather than a geocoding service — a home address is the
// most personal thing this app stores, and it never leaves the machine.
export function HomePanel({ profile, onChanged }) {
  const [value, setValue] = useState(profile.home_label || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  async function save() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const d = await api('/api/profile/home', { method: 'POST', body: { home: value } });
      setMsg(d.cleared ? 'Rensad' : `Hittad via ${d.how} (${d.basedOn} annonser)`);
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <section className="cvprofile">
      <div className="cvp-head">
        <div>
          <h3>Var du reser ifrån</h3>
          <p className="cvp-sub">
            Används för att räkna ut avstånd till varje jobb. Skriv ett postnummer
            eller en ort. Slås upp mot koordinaterna som redan finns i annonserna —
            ingen karttjänst kontaktas och adressen lämnar aldrig din dator.
            {profile.home_label && <> Nu: <b>{profile.home_label}</b>.</>}
          </p>
        </div>
      </div>
      <div className="home-row">
        <input
          className="ct-input"
          placeholder="t.ex. 118 26 eller Södermalm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        />
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? <>Slår upp<Dots label="Slår upp" /></> : 'Spara'}
        </button>
      </div>
      {msg && <div className="home-msg">✓ {msg}</div>}
      {err && <div className="err-note">{err}</div>}
    </section>
  );
}

export default function CvProfilePanel({ profile, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  const p = profile.cv_profile;

  async function rebuild() {
    setBusy(true); setError(null);
    try {
      await api('/api/profile/cv-profile', { method: 'POST' });
      onChanged?.();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  const groups = [
    // Experience first: it is what a non-tech ad is matched against, and
    // the part most likely to have been dropped by a careless reading.
    ['experience', 'Erfarenhet', (f) =>
      `${f.role}${f.employer ? `, ${f.employer}` : ''}${f.period ? ` · ${f.period}` : ''}`
      + `${f.field ? ` — ${f.field}` : ''}`],
    ['skills', 'Kompetenser', (f) => `${f.name}${f.field ? ` · ${f.field}` : ''}${f.strength ? ` · ${f.strength}` : ''}`],
    ['implicit_skills', 'Visar också', (f) => `${f.name} — ${f.why}`],
    ['domains', 'Domäner', (f) => f.name],
    ['education', 'Utbildning', (f) => `${f.what}, ${f.where}`],
  ];
  const facts = p ? groups.flatMap(([k]) => p[k] || []) : [];
  const unverified = facts.filter((f) => !f.verbatim).length;

  return (
    <section className="cvprofile">
      <div className="cvp-head">
        <div>
          <h3>Vad appen har läst ut ur ditt CV</h3>
          <p className="cvp-sub">
            {p
              ? <>Läses <b>en gång</b> och återanvänds i varje bedömning och varje brev — inte
                  tolkat på nytt per annons. {facts.length} fakta
                  {unverified > 0 && <>, <b className="warn">{unverified} utan ordagrant belägg</b></>}.
                  {profile.cv_profile_model && <> Byggd av <code>{profile.cv_profile_model}</code>.</>}</>
              : 'Ingen profil byggd än — ladda upp ett CV, eller bygg om nedan.'}
          </p>
        </div>
        <button className="btn" onClick={rebuild} disabled={busy || !profile.cv_text}>
          {busy ? <>Läser CV<Dots label="Läser CV" /></> : p ? 'Bygg om' : 'Läs mitt CV'}
        </button>
      </div>

      {error && <div className="err-note">{error}</div>}

      {p && (
        <>
          <div className="cvp-summary">
            <b>{p.headline}</b>
            <span>{[p.seniority, p.years_experience && `~${p.years_experience} år`]
              .filter(Boolean).join(' · ')}</span>
          </div>

          {p.gaps?.length > 0 && (
            <div className="cvp-gaps">
              <span className="cvp-label">Kända luckor</span>
              {p.gaps.map((g, i) => <span key={i} className="cvp-gap">{g}</span>)}
            </div>
          )}

          <button className="cvp-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? '▴ Dölj underlaget' : `▾ Visa alla ${facts.length} fakta och var de kommer ifrån`}
          </button>

          {open && groups.map(([key, label, fmt]) => (
            (p[key]?.length > 0) && (
              <div key={key} className="cvp-group">
                <span className="cvp-label">{label}</span>
                {p[key].map((f, i) => (
                  <div key={i} className={`cvp-fact${f.verbatim ? '' : ' unverified'}`}>
                    <b>{fmt(f)}</b>
                    <q title={f.evidence}>{f.evidence}</q>
                    {!f.verbatim && <em>hittades inte ordagrant i CV:t — kontrollera</em>}
                  </div>
                ))}
              </div>
            )
          ))}
        </>
      )}
    </section>
  );
}
