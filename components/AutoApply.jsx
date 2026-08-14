'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, timeAgo } from '../lib/api.js';
import { usePoll } from '../lib/usePoll.js';
import Inbox from './Inbox.jsx';
import CampaignLetter from './CampaignLetter.jsx';

// ------------------------------------------------------------
// Auto-apply campaigns, in their own workspace.
//
// The approval this screen collects is for a RULE, not a letter, so
// it has to show exactly what the rule would do: the queue that
// would go out next, the cap, and a log of everything already sent.
// ------------------------------------------------------------
export default function AutoApply({ onFindSimilar }) {
  const [view, setView] = useState('campaigns');   // campaigns | letter | inbox
  const [letterFor, setLetterFor] = useState(null);   // search being written for
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [dry, setDry] = useState({});              // searchId -> dry-run result
  const [creating, setCreating] = useState(false);
  const [newCriteria, setNewCriteria] = useState('');
  const [newName, setNewName] = useState('');

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

  async function createCampaign() {
    if (!newCriteria.trim() || busy) return;
    setBusy('new'); setError(null);
    try {
      const s = await api('/api/autoapply/new', {
        method: 'POST', body: { name: newName, criteria: newCriteria },
      });
      setCreating(false); setNewCriteria(''); setNewName('');
      await load();
      // straight to writing the letter — a campaign is useless without one
      setLetterFor(s);
      setView('letter');
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  if (!data) return <div className="loading-note">{error || 'Laddar…'}</div>;

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
            </p>
          </div>

          {creating && (
            <div className="auto-new">
              <label>
                <span>Vilka annonser ska kampanjen gälla?</span>
                <textarea
                  className="txt-area" rows={3}
                  placeholder="T.ex. junior frontendroller i Stockholm med React, inget krav på flera års erfarenhet"
                  value={newCriteria} onChange={(e) => setNewCriteria(e.target.value)}
                />
              </label>
              <label>
                <span>Namn (valfritt)</span>
                <input className="txt-input" type="text" placeholder="Frontend Stockholm"
                  value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>
              <p className="hint">
                Kampanjen skapas avstängd och utan brev. Nästa steg är att skriva
                kampanjbrevet tillsammans med AI:n — inget skickas innan du godkänt det.
              </p>
              <button className="btn primary" disabled={busy === 'new' || !newCriteria.trim()}
                onClick={createCampaign}>
                {busy === 'new' ? 'Skapar…' : 'Skapa kampanj →'}
              </button>
            </div>
          )}

          {noCv && (
            <div className="auto-warn">
              ⚠ Inget CV-dokument uppladdat. Kampanjer skickar inget förrän du laddar
              upp ditt CV som fil (PDF/DOCX) i Profil — annonserna ber om det.
            </div>
          )}

          {error && <div className="err-note" style={{ margin: '0 0 12px' }}>{error}</div>}

          <div className="auto-list">
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
                      </span>
                    </div>
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
                        type="number" min="1" max="20" className="txt-input"
                        value={s.auto_apply_daily_limit}
                        onChange={(e) => update(s.id, { daily_limit: e.target.value })}
                      />
                    </label>
                  </div>

                  <div className="auto-queue">
                    <span className="auto-queue-title">
                      Näst på tur ({queue.length}) — annonser över {s.auto_apply_min_score} poäng med mejladress
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
