'use client';
import { useEffect, useState } from 'react';
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

// ------------------------------------------------------------
// Whether the worker is allowed to spend money embedding ads.
//
// Off by default. Embedding costs per ad and nothing reads the vectors
// yet, so with no credit the only thing the 60-second tick achieved was
// a 402 in the log every minute — and a background job that fails
// forever is how a real failure later gets ignored.
//
// The vectors already paid for are kept either way. Switching this off
// pauses the spending; it does not throw away the 17 000 ads already
// done, which would make turning it back on cost twice.
// ------------------------------------------------------------
export function EmbeddingPanel() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api('/api/profile/embeddings').then(setS).catch((e) => setErr(e.message));
  }, []);

  async function toggle(next) {
    setBusy(true); setErr(null);
    try { setS(await api('/api/profile/embeddings', { method: 'PATCH', body: { enabled: next } })); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }

  if (!s) return null;

  return (
    <section className="cvprofile">
      <div className="cvp-head">
        <div>
          <h3>Vektorindex för annonser</h3>
          <p className="cvp-sub">
            {s.enabled
              ? <>På. Nya annonser indexeras i bakgrunden, ungefär
                  <b> ${s.estimatedUsd.toFixed(2)}</b> för de {s.remaining.toLocaleString('sv-SE')} som
                  återstår. Betalas per annons, en gång.</>
              : <>Av. Ingenting indexeras och inget kostar något. Resten av appen
                  påverkas inte — sökning, bedömning och brev använder inte
                  vektorerna än.</>}
            {' '}
            {s.embedded.toLocaleString('sv-SE')} av {s.total.toLocaleString('sv-SE')} annonser
            är redan indexerade ({s.pct}%) och behålls oavsett.
          </p>
        </div>
        <button className="btn" onClick={() => toggle(!s.enabled)} disabled={busy}>
          {busy ? <>Sparar<Dots label="Sparar" /></> : s.enabled ? 'Stäng av' : 'Slå på'}
        </button>
      </div>
      {err && <div className="err-note">{err}</div>}
    </section>
  );
}

// ------------------------------------------------------------
// What the app costs to run, and what it is allowed to cost.
//
// The budget is set in money because money is what runs out. Everything
// else worth capping — ads judged, letters sent — follows from it and
// from what the chosen models charge, so raising the budget raises the
// capacity without the user doing the arithmetic themselves.
//
// The per-unit prices are measured from this install's own calls, not
// read off a price list: they carry this CV's length and these ads'
// length, which is what actually determines the bill.
// ------------------------------------------------------------
export function BudgetPanel() {
  const [b, setB] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => api('/api/profile/budget').then(setB).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function save(patch) {
    setBusy(true); setErr(null);
    try { setB(await api('/api/profile/budget', { method: 'PATCH', body: patch })); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }

  if (!b) return null;
  const kr = (usd) => `$${usd.toFixed(2)}`;

  return (
    <section className="cvprofile">
      <div className="cvp-head">
        <div>
          <h3>Kostnad och tak</h3>
          <p className="cvp-sub">
            {b.credit
              ? <><b>{kr(b.credit.left)}</b> kvar hos {b.provider} av {kr(b.credit.bought)} köpta. </>
              : <>Ingen saldouppgift från {b.provider}. </>}
            Bedömning körs på <code>{b.models.bulk}</code>, brev på <code>{b.models.write}</code>.
          </p>
        </div>
      </div>

      <div className="budget-grid">
        <div className="budget-stat">
          <b>{kr(b.spent.usd)}</b>
          <span>använt denna månad</span>
        </div>
        <div className="budget-stat">
          <b>${b.unit.score.toFixed(4)}</b>
          <span>per bedömd annons</span>
        </div>
        <div className="budget-stat">
          <b>${b.unit.letter.toFixed(4)}</b>
          <span>per brev</span>
        </div>
      </div>
      {b.unit.measured.score > 0
        ? <p className="hint">Styckpriserna är mätta på dina egna {b.unit.measured.score} senaste
            bedömningar — inte hämtade ur en prislista.</p>
        : <p className="hint">Styckpriserna är uppskattade tills appen kört några anrop med
            mätning påslagen; då byts de mot dina faktiska.</p>}

      <div className="budget-row">
        <label>
          <span>Tak per månad (USD)</span>
          <input
            className="txt-input" type="number" min="0" max="1000" step="1"
            value={b.budget ?? ''}
            placeholder="inget tak"
            onChange={(e) => setB({ ...b, budget: e.target.value === '' ? null : Number(e.target.value) })}
            onBlur={(e) => save({ monthly_budget_usd: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
        <label>
          <span>Max bedömningar per dygn</span>
          <input
            className="txt-input" type="number" min="1" max="2000"
            defaultValue={b.dailyScoreLimit}
            onBlur={(e) => save({ daily_score_limit: Number(e.target.value) })}
          />
        </label>
      </div>

      {b.capacity ? (
        <>
          <div className="budget-scale">
            {[['per månad', b.capacity.month], ['per vecka', b.capacity.week],
              ['per dygn', b.capacity.day]].map(([label, n]) => (
              <span className="scale-step" key={label}>
                <b>{n.toLocaleString('sv-SE')}</b><span>annonser {label}</span>
              </span>
            ))}
          </div>
          <p className="hint">
            {kr(b.remaining)} kvar av taket, {b.daysLeft} dagar av månaden igen — det räcker
            till <b>{b.capacity.todayLeft.toLocaleString('sv-SE')}</b> bedömningar idag om du
            fördelar jämnt. Brev kostar en tiondel så mycket och ryms i alla fall.
          </p>
        </>
      ) : (
        <p className="hint">
          Utan tak spenderar appen vad arbetet kräver. Sätt ett tak ovan så räknas det om
          till hur många annonser som kan bedömas per månad, vecka och dygn.
        </p>
      )}
      {busy && <div className="home-msg">sparar…</div>}
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
