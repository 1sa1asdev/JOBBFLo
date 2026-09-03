'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, timeAgo } from '../lib/api.js';
import { usePoll } from '../lib/usePoll.js';
import Inbox from './Inbox.jsx';
import CampaignLetter from './CampaignLetter.jsx';
import Dots from './Dots';
import LocationPicker from './LocationPicker.jsx';
import CampaignWizard from './CampaignWizard.jsx';

// ------------------------------------------------------------
// Auto-apply campaigns, in their own workspace.
//
// The approval this screen collects is for a RULE, not a letter, so
// it has to show exactly what the rule would do: the queue that
// would go out next, the cap, and a log of everything already sent.
// ------------------------------------------------------------
// ------------------------------------------------------------
// How a campaign's daily letters are divided between its places.
//
// Shown only when more than one place is chosen, because with one place
// the question does not exist. Weights are relative — 2 and 1 rather
// than 67% and 33% — so adding a third place does not force the user to
// rebalance the other two, and nothing has to add up to 100.
//
// The preview underneath is the point: a ratio is abstract, "2 brev
// Stockholm, 1 brev Linköping" is not, and it is the same
// largest-remainder arithmetic the sender uses.
// ------------------------------------------------------------
function RatioPicker({ places, ratio, dailyLimit, onSave }) {
  const on = Boolean(ratio);
  const weights = Object.fromEntries(places.map((p) => [p, Number(ratio?.[p]) || 1]));

  // Same allocation as src/autoapply.js: floor everything, then hand the
  // remaining slots to the largest fractions. Plain rounding drops or
  // invents a letter, and the daily number has to be exact.
  function preview() {
    const total = places.reduce((n, p) => n + (weights[p] || 0), 0);
    if (!total) return places.map((p) => [p, 0]);
    const exact = places.map((p) => ({ p, want: (dailyLimit * (weights[p] || 0)) / total }));
    const out = new Map(exact.map((e) => [e.p, Math.floor(e.want)]));
    let left = dailyLimit - [...out.values()].reduce((a, b) => a + b, 0);
    for (const e of [...exact].sort((a, b) => (b.want % 1) - (a.want % 1))) {
      if (left <= 0) break;
      out.set(e.p, out.get(e.p) + 1); left -= 1;
    }
    return places.map((p) => [p, out.get(p)]);
  }

  return (
    <div className="auto-ratio">
      <label className="auto-switch">
        <input type="checkbox" checked={on}
          onChange={(e) => onSave(e.target.checked ? weights : null)} />
        <span>Fördela breven mellan orterna</span>
      </label>

      {on ? (
        <>
          {places.map((p) => (
            <div className="ratio-row" key={p}>
              <span className="ratio-name">{p}</span>
              <input
                type="range" min="0" max="10" step="1"
                value={weights[p]}
                onChange={(e) => onSave({ ...weights, [p]: Number(e.target.value) })}
              />
              <span className="ratio-w">{weights[p]}</span>
            </div>
          ))}
          <p className="hint">
            Av {dailyLimit} brev per dygn: {preview().map(([p, n]) => `${n} ${p}`).join(' · ')}.
            Räcker inte annonserna på en ort går platserna till de andra — hellre
            skickade brev än en exakt kvot.
          </p>
        </>
      ) : (
        <p className="hint">
          Utan fördelning avgör poängen ensam, och då hamnar nästan alla brev
          där det finns flest annonser.
        </p>
      )}
    </div>
  );
}

export default function AutoApply({ onFindSimilar }) {
  const [view, setView] = useState('campaigns');   // campaigns | letter | inbox
  const [letterFor, setLetterFor] = useState(null);   // search being written for
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [dry, setDry] = useState({});              // searchId -> dry-run result
  const [creating, setCreating] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api('/api/autoapply')); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  usePoll(load, { interval: 8000, enabled: view === 'campaigns' });

  async function update(searchId, patch) {
    setBusy(searchId); setError(null);
    try {
      await api('/api/autoapply', { method: 'PATCH', body: { searchId, ...patch } });
      await load();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function preview(searchId) {
    setBusy(searchId); setError(null);
    try {
      const result = await api('/api/autoapply', {
        method: 'POST', body: { searchId, dryRun: true },
      });
      setDry((d) => ({ ...d, [searchId]: result }));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function createCampaign(form) {
    if (!form.criteria?.trim() || busy) return;
    setBusy('new'); setError(null);
    try {
      const s2 = await api('/api/autoapply/new', { method: 'POST', body: form });
      setCreating(false);
      await load();
      // straight to writing the letter — a campaign is useless without one
      setLetterFor(s2);
      setView('letter');
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  // A campaign IS a search underneath, so deleting the search here
  // would destroy the user's saved search, its criteria and every
  // scored ad — for someone who only meant to stop a campaign.
  // Removing a campaign therefore clears the campaign, and the
  // search survives. Deleting the search itself stays in the library,
  // where the consequence is obvious.
  async function removeCampaign(searchId) {
    setBusy(searchId); setError(null);
    try {
      await api('/api/autoapply', {
        method: 'PATCH',
        body: { searchId, enabled: false, clear_campaign: true },
      });
      setConfirmDel(null);
      if (letterFor?.id === searchId) setLetterFor(null);
      await load();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  if (!data) return <div className="loading-note">{error || <>Laddar<Dots /></>}</div>;

  const noCv = !data.cv;
  const anyOn = data.searches.some((s) => s.auto_apply_enabled);

  return (
    <div className="auto-wrap">
      <div className="auto-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'campaigns'} onClick={() => setView('campaigns')}>
          Kampanjer
        </button>
        <button role="tab" aria-selected={view === 'letter'}
          onClick={() => { setView('letter'); if (!letterFor) setLetterFor(data?.searches?.[0] || null); }}>
          Kampanjbrev
        </button>
        <button role="tab" aria-selected={view === 'inbox'} onClick={() => setView('inbox')}>
          Auto-inkorg
        </button>
      </div>

      {view === 'inbox' ? (
        <Inbox source="auto" onFindSimilar={onFindSimilar} />
      ) : view === 'letter' ? (
        <div className="cl-shell">
          <div className="cl-picker">
            {(data?.searches || []).map((s2) => (
              <button
                key={s2.id}
                className={`cl-pick${letterFor?.id === s2.id ? ' active' : ''}`}
                onClick={() => setLetterFor(s2)}
              >
                {s2.name}
              </button>
            ))}
          </div>
          <CampaignLetter search={letterFor} onChanged={load} />
        </div>
      ) : (
        <div className="auto-body">
          <div className="auto-head">
            <div className="idx">04 / Automatisk ansökan</div>
            <div className="auto-title-row">
              <h2>Kampanjer</h2>
              <button className="btn primary" onClick={() => setCreating(!creating)}>
                {creating ? 'Avbryt' : '+ Ny kampanj'}
              </button>
            </div>
            <p className="auto-lede">
              En kampanj ansöker åt dig utan att fråga varje gång. Du godkänner
              <b> regeln</b> — inte breven. Bara annonser som själva publicerar en
              ansökningsadress används, och bara när ett CV finns att bifoga.
              Kampanjer bedömer därför bara mejlannonser — övriga går inte att
              skicka till, så de kostar inget att hoppa över.
            </p>
          </div>

          {creating && (
            <CampaignWizard
              busy={busy === 'new'}
              error={error}
              onCreate={createCampaign}
              onCancel={() => setCreating(false)}
            />
          )}

          {noCv && (
            <div className="auto-warn">
              ⚠ Inget CV-dokument uppladdat. Kampanjer skickar inget förrän du laddar
              upp ditt CV som fil (PDF/DOCX) i Profil — annonserna ber om det.
            </div>
          )}

          {error && <div className="err-note" style={{ margin: '0 0 12px' }}>{error}</div>}

          <div className="auto-list">
            {/* Before, this list showed every saved search, so it was
                never empty and never honest. Now that it holds only real
                campaigns it can be empty — and empty needs to say so
                rather than look like something failed to load. */}
            {!data.searches.length && !creating && (
              <p className="hint">
                Inga kampanjer än. En sökning i biblioteket blir inte en kampanj av sig
                själv — skapa en här när du vill att appen ansöker åt dig.
              </p>
            )}
            {data.searches.map((s) => {
              const queue = s.candidates || [];
              const d = dry[s.id];
              return (
                <div className={`auto-card${s.auto_apply_enabled ? ' on' : ''}`} key={s.id}>
                  <div className="auto-card-head">
                    <div>
                      <span className="auto-name">{s.name}</span>
                      <span className="auto-stats">
                        {s.sent_total} skickade totalt · {s.sent_today} idag
                        {/* Without this the card says nothing about whether
                            the campaign is still finding ads, which is the
                            first thing you want to know when it has sent
                            nothing yet. */}
                        {s.fetch_done_at
                          ? (s.scan_enabled ? ' · bevakar nya annonser' : ' · bevakning av')
                          : s.fetch_total
                            ? <> · <span className="scanning">söker igenom</span> {Math.min(s.fetch_offset || 0, s.fetch_total)} av {s.fetch_total}</>
                            : <> · <span className="scanning">söker …</span></>}
                      </span>
                    </div>
                    <div className="auto-head-acts">
                    <button
                      className="auto-del"
                      title={`Ta bort kampanjen för ${s.name} (sökningen behålls)`}
                      aria-label={`Ta bort kampanjen för ${s.name}`}
                      onClick={() => setConfirmDel(confirmDel === s.id ? null : s.id)}
                    >✕</button>
                    <button
                      className={`auto-toggle${s.auto_apply_enabled ? ' on' : ''}`}
                      title={!s.campaign_letter_approved_at ? 'Skriv och godkänn kampanjbrevet först' : ''}
                      disabled={busy === s.id || (!s.auto_apply_enabled && (noCv || !s.campaign_letter_approved_at))}
                      onClick={() => update(s.id, { enabled: !s.auto_apply_enabled })}
                      aria-pressed={s.auto_apply_enabled}
                    >
                      {s.auto_apply_enabled ? 'PÅ' : 'AV'}
                    </button>
                    </div>
                  </div>

                  {confirmDel === s.id && (
                    <div className="auto-confirm">
                      <span>Ta bort kampanjen för <b>{s.name}</b>?</span>
                      <span className="ac-note">
                        Kampanjbrevet och reglerna raderas och automatiken stängs av.
                        Sökningen, dess annonser och redan skickade ansökningar
                        påverkas inte — sökningen tas bort i Bibliotek.
                      </span>
                      <div className="ac-acts">
                        <button className="btn" onClick={() => setConfirmDel(null)}>Avbryt</button>
                        <button className="btn primary" disabled={busy === s.id}
                          onClick={() => removeCampaign(s.id)}>
                          {busy === s.id ? 'Tar bort…' : 'Ta bort'}
                        </button>
                      </div>
                    </div>
                  )}

                  {!s.campaign_letter_approved_at && (
                    <div className="auto-needletter">
                      Inget godkänt kampanjbrev.{' '}
                      <button className="linkish" onClick={() => { setLetterFor(s); setView('letter'); }}>
                        Skriv brevet →
                      </button>
                    </div>
                  )}
                  {s.auto_apply_paused_reason && (
                    <div className="auto-paused">⏸ Pausad: {s.auto_apply_paused_reason}</div>
                  )}

                  {/* A campaign can cover several places at once —
                      Linköping and Stockholm is one campaign, not two.
                      Same control as the search strip, because it is
                      the same question. */}
                  <div className="auto-locs">
                    <LocationPicker
                      label="Orter"
                      value={s.location || []}
                      onSave={async (next) => {
                        await api(`/api/searches/${s.id}`, {
                          method: 'PATCH', body: { location: next },
                        });
                        await load();
                      }}
                    />
                  </div>

                  <div className="auto-rules">
                    <label>
                      <span>Minsta matchpoäng</span>
                      <input
                        type="number" min="0" max="100" className="txt-input"
                        value={s.auto_apply_min_score}
                        onChange={(e) => update(s.id, { min_score: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>Max per dygn</span>
                      <input
                        type="number" min="1" max="100" className="txt-input"
                        value={s.auto_apply_daily_limit}
                        onChange={(e) => update(s.id, { daily_limit: e.target.value })}
                      />
                    </label>
                  </div>

                  {/* Only worth asking once there is something to split.
                      Stockholm carries several times Linköping's volume,
                      so without this the biggest city takes nearly every
                      letter — by ad supply, not by choice. */}
                  {(s.location || []).length > 1 && (
                    <RatioPicker
                      places={s.location}
                      ratio={s.location_ratio}
                      dailyLimit={s.auto_apply_daily_limit}
                      onSave={(r) => update(s.id, { location_ratio: r })}
                    />
                  )}

                  {/* Criteria the taxonomy cannot express. "Bara juniora
                      roller" is not a filter — seniority lives in the ad's
                      prose — so this is read by the model while it scores,
                      as a gate rather than a preference. Which is exactly
                      why it does nothing when scoring is off, and says so. */}
                  <div className="auto-must">
                    <label>
                      <span>Absolut krav (fritext)</span>
                      <textarea
                        className="txt-area" rows={2}
                        placeholder="T.ex. bara juniora utvecklarroller, inga chefsroller"
                        defaultValue={s.must_criteria || ''}
                        onBlur={(e) => {
                          if ((e.target.value || '') !== (s.must_criteria || '')) {
                            update(s.id, { must_criteria: e.target.value });
                          }
                        }}
                      />
                    </label>
                    <p className="hint">
                      {!s.auto_apply_require_score && s.must_criteria
                        ? <><b className="warn">Gäller inte just nu.</b> Kravet läses av modellen
                            när annonsen bedöms, och bedömning är avstängd nedan — slå på den
                            för att kravet ska ha någon effekt.</>
                        : <>Läses av modellen vid bedömningen. Uppfylls det inte får annonsen
                            högst 15 poäng och hamnar därmed under gränsen — inget brev skickas.
                            Går det inte att avgöra ur annonstexten räknas kravet som ej uppfyllt.</>}
                    </p>
                  </div>

                  {/* The only setting here that changes what gets spent.
                      Off, no model reads the ad text and the API filters
                      decide alone — cheap, and blunt in exactly the way
                      the copy says. */}
                  <div className="auto-scoring">
                    <label className="auto-switch">
                      <input
                        type="checkbox"
                        checked={!s.auto_apply_require_score}
                        onChange={(e) => update(s.id, { require_score: !e.target.checked })}
                      />
                      <span>Ansök utan att bedöma annonserna först</span>
                    </label>
                    <p className="hint">
                      {s.auto_apply_require_score
                        ? <>Varje annons bedöms av en modell innan den räknas — det är
                            den enda delen av kampanjen som kostar tokens.</>
                        : <><b>Inga tokens.</b> Kampanjen litar helt på sökfiltren:
                            ingen modell läser annonstexten, så inget fångar krav som
                            taxonomin inte uttrycker. Annonser som redan har poäng måste
                            fortfarande nå {s.auto_apply_min_score}.</>}
                    </p>
                  </div>

                  <div className="auto-queue">
                    <span className="auto-queue-title">
                      Näst på tur ({queue.length}) — {s.auto_apply_require_score
                        ? <>annonser över {s.auto_apply_min_score} poäng med mejladress</>
                        : <>annonser med mejladress som matchar filtren, bedömda eller ej</>}
                    </span>
                    {queue.length === 0 && <p className="hint">Inga annonser uppfyller regeln just nu.</p>}
                    {queue.map((c) => (
                      <div className="auto-q" key={c.ad_id}>
                        <b>{c.score}</b>
                        <span className="auto-q-title">{c.title}</span>
                        <span className="auto-q-emp">{c.employer}</span>
                        <span className="auto-q-mail">{c.apply_email}</span>
                        {c.deadline && <span className="auto-q-dl">till {fmtDate(c.deadline)}</span>}
                      </div>
                    ))}
                  </div>

                  <div className="auto-acts">
                    <button className="btn" disabled={busy === s.id} onClick={() => preview(s.id)}>
                      {busy === s.id ? 'Kollar…' : 'Visa vad som skulle skickas'}
                    </button>
                  </div>

                  {d && (
                    <div className="auto-dry">
                      {d.sent > 0
                        ? <>Skulle skicka <b>{d.sent}</b> ansökningar nu: {d.sentTo.map((x) => `${x.employer} (${x.score})`).join(', ')}</>
                        : <>Skulle inte skicka något{d.reason ? ` — ${d.reason}` : ''}.</>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="auto-log">
            <span className="auto-queue-title">Händelselogg</span>
            {data.log.length === 0 && <p className="hint">Inget skickat automatiskt än.</p>}
            {data.log.map((l) => (
              <div className={`auto-log-row ${l.outcome}`} key={l.id}>
                <span className="alr-when">{timeAgo(l.created_at)}</span>
                <span className="alr-out">{l.outcome === 'sent' ? '✓ skickad' : l.outcome === 'failed' ? '✗ fel' : '– hoppad'}</span>
                <span className="alr-title">{l.title || l.search_name || '—'}</span>
                <span className="alr-detail">{l.detail}</span>
              </div>
            ))}
          </div>

          {anyOn && (
            <p className="hint auto-gdpr">
              Kampanjer skickar riktiga mejl från ditt Gmail i ditt namn, utan att fråga
              per brev. Stäng av med PÅ/AV ovan — en kampanj pausar också sig själv vid
              första fel.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
