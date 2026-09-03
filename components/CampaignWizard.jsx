'use client';
import { useState } from 'react';
import LocationPicker from './LocationPicker.jsx';
import Dots from './Dots';

// ------------------------------------------------------------
// Setting up a campaign, in steps.
//
// A campaign is the one thing in this app that sends without anyone
// reading the letter first, so every setting that decides WHAT it sends
// belongs before it exists — not discovered afterwards on a card. The
// old form asked for a sentence of prose and nothing else, which left
// the model to guess the cities from that prose. A guess is fine for a
// search you are watching; it is not fine for a rule that mails
// strangers on your behalf.
//
// Steps rather than one long form, because each answers a different
// question — what, where, which, how much — and the last step can then
// show the whole rule in one place before anything is created.
//
// Nothing here can send. The campaign is created switched off and
// without a letter; writing and approving that letter is still a
// separate, deliberate act.
// ------------------------------------------------------------
const STEPS = ['Vad', 'Var', 'Villkor', 'Regler'];

export default function CampaignWizard({ busy, error, onCreate, onCancel }) {
  const [step, setStep] = useState(0);

  const [name, setName] = useState('');
  const [criteria, setCriteria] = useState('');
  const [locations, setLocations] = useState([]);
  const [ratio, setRatio] = useState(null);
  const [worktime, setWorktime] = useState(null);
  const [mustCriteria, setMustCriteria] = useState('');
  const [minScore, setMinScore] = useState(85);
  const [dailyLimit, setDailyLimit] = useState(3);
  const [requireScore, setRequireScore] = useState(true);

  // The only field without which nothing downstream works: it becomes
  // the API filters AND the text every score is judged against.
  const canProceed = step > 0 || criteria.trim().length > 0;

  const weights = Object.fromEntries(locations.map((p) => [p, Number(ratio?.[p]) || 1]));

  function submit() {
    onCreate({
      name, criteria,
      locations,
      location_ratio: locations.length > 1 ? ratio : null,
      worktime,
      must_criteria: mustCriteria,
      min_score: minScore,
      daily_limit: dailyLimit,
      require_score: requireScore,
    });
  }

  return (
    <div className="auto-new wizard">
      <div className="wiz-steps" role="list">
        {STEPS.map((s, i) => (
          <button
            key={s}
            role="listitem"
            className={`wiz-step${i === step ? ' active' : ''}${i < step ? ' done' : ''}`}
            // Back is always free; forward needs the one required field.
            disabled={i > step && !criteria.trim()}
            onClick={() => setStep(i)}
          >
            <span className="wiz-num">{i + 1}</span>{s}
          </button>
        ))}
      </div>

      {step === 0 && (
        <>
          <label>
            <span>Vilka annonser ska kampanjen gälla?</span>
            <textarea
              className="txt-area" rows={3} autoFocus
              placeholder="T.ex. juniora frontendroller med React, inget krav på flera års erfarenhet"
              value={criteria} onChange={(e) => setCriteria(e.target.value)}
            />
          </label>
          <p className="hint">
            Den här texten blir både sökfiltren och det varje annons bedöms mot.
            Skriv den som du skulle beskriva jobbet för en kompis.
          </p>
          <label>
            <span>Namn (valfritt)</span>
            <input className="txt-input" type="text" placeholder="Frontend Stockholm"
              value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </>
      )}

      {step === 1 && (
        <>
          <LocationPicker label="Orter" value={locations} onSave={(next) => {
            setLocations(next);
            // Keep only weights for places still chosen, so removing a
            // city cannot leave a ghost weight skewing the split.
            if (ratio) {
              setRatio(Object.fromEntries(next.map((p) => [p, Number(ratio[p]) || 1])));
            }
          }} />
          <p className="hint">
            Lämna tomt för hela Sverige. Väljer du flera orter söker kampanjen i
            alla — Arbetsförmedlingens API slår ihop dem.
          </p>

          {locations.length > 1 && (
            <div className="auto-ratio">
              <label className="auto-switch">
                <input type="checkbox" checked={Boolean(ratio)}
                  onChange={(e) => setRatio(e.target.checked ? weights : null)} />
                <span>Fördela breven mellan orterna</span>
              </label>
              {ratio ? (
                <>
                  {locations.map((p) => (
                    <div className="ratio-row" key={p}>
                      <span className="ratio-name">{p}</span>
                      <input type="range" min="0" max="10" step="1" value={weights[p]}
                        onChange={(e) => setRatio({ ...weights, [p]: Number(e.target.value) })} />
                      <span className="ratio-w">{weights[p]}</span>
                    </div>
                  ))}
                  <p className="hint">Vikterna är relativa — 2 och 1 betyder dubbelt så många brev till den första.</p>
                </>
              ) : (
                <p className="hint">
                  Utan fördelning avgör poängen ensam, och nästan alla brev hamnar
                  där det finns flest annonser.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <div className="wiz-field">
            <span className="wiz-label">Omfattning</span>
            <div className="ct-seg" role="group" aria-label="Omfattning">
              {[[null, 'Alla'], ['Deltid', 'Deltid'], ['Heltid', 'Heltid']].map(([v, l]) => (
                <button key={l} type="button" aria-pressed={worktime === v}
                  onClick={() => setWorktime(v)}>{l}</button>
              ))}
            </div>
          </div>
          <p className="hint">
            Annonser som inte anger omfattning tas alltid med — de är ofta just
            extrajobb och att sålla bort dem vore att missa dem.
          </p>

          <label>
            <span>Absolut krav (fritext, valfritt)</span>
            <textarea
              className="txt-area" rows={2}
              placeholder="T.ex. bara juniora roller, inga chefstjänster"
              value={mustCriteria} onChange={(e) => setMustCriteria(e.target.value)}
            />
          </label>
          <p className="hint">
            Sådant som inte går att uttrycka som filter. Läses av modellen vid
            bedömningen: uppfylls det inte får annonsen högst 15 poäng och hamnar
            under gränsen, så inget brev skickas.
          </p>
        </>
      )}

      {step === 3 && (
        <>
          <div className="wiz-row">
            <label>
              <span>Minsta matchpoäng</span>
              <input className="txt-input" type="number" min="0" max="100"
                value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
            </label>
            <label>
              <span>Max brev per dygn</span>
              <input className="txt-input" type="number" min="1" max="100"
                value={dailyLimit} onChange={(e) => setDailyLimit(Number(e.target.value))} />
            </label>
          </div>

          <label className="auto-switch">
            <input type="checkbox" checked={!requireScore}
              onChange={(e) => setRequireScore(!e.target.checked)} />
            <span>Ansök utan att bedöma annonserna först</span>
          </label>
          <p className="hint">
            {requireScore
              ? 'Varje annons bedöms av en modell innan den räknas — den enda delen som kostar tokens.'
              : 'Inga tokens. Kampanjen litar helt på sökfiltren, och inget absolut krav kan kontrolleras.'}
          </p>

          <div className="wiz-summary">
            <div><span>Söker</span><b>{criteria.trim() || '—'}</b></div>
            <div><span>Orter</span><b>{locations.length ? locations.join(', ') : 'hela Sverige'}</b></div>
            {locations.length > 1 && ratio && (
              <div><span>Fördelning</span><b>{locations.map((p) => `${p} ${weights[p]}`).join(' · ')}</b></div>
            )}
            <div><span>Omfattning</span><b>{worktime || 'alla'}</b></div>
            {mustCriteria.trim() && <div><span>Absolut krav</span><b>{mustCriteria.trim()}</b></div>}
            <div><span>Regel</span><b>
              {requireScore ? `minst ${minScore} poäng` : 'ingen bedömning'}, max {dailyLimit}/dygn
            </b></div>
          </div>
          <p className="hint">
            Kampanjen skapas <b>avstängd och utan brev</b>. Nästa steg är att skriva
            kampanjbrevet — inget skickas förrän du godkänt det.
          </p>
        </>
      )}

      {error && <div className="err-note">{error}</div>}

      <div className="wiz-nav">
        <button className="btn" onClick={step === 0 ? onCancel : () => setStep(step - 1)}>
          {step === 0 ? 'Avbryt' : '← Tillbaka'}
        </button>
        {step < STEPS.length - 1 ? (
          <button className="btn primary" disabled={!canProceed}
            onClick={() => setStep(step + 1)}>Nästa →</button>
        ) : (
          <button className="btn primary" disabled={busy || !criteria.trim()} onClick={submit}>
            {busy ? <>Skapar<Dots label="Skapar" /></> : 'Skapa kampanj →'}
          </button>
        )}
      </div>
    </div>
  );
}
