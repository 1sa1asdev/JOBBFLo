'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDate, daysUntil, timeAgo } from '../lib/api.js';
import { usePoll } from '../lib/usePoll.js';
import Dots from './Dots';
import ApplyFilterSeg from './ApplyFilterSeg.jsx';

function scoreClass(s) { return s >= 75 ? 'strong' : s < 45 ? 'flagged' : ''; }

function statusChip(r) {
  if (r.suppressed) return { cls: '', label: 'Dold' };
  if (r.applied_via_other_search) return { cls: 'sent', label: 'Sökt via annan sökning' };
  switch (r.application_status) {
    case 'drafted': return { cls: 'drafted', label: 'Utkast' };
    case 'sent': return { cls: 'sent', label: 'Skickad' };
    case 'replied': return { cls: 'fresh', label: 'Svar inne' };
    case 'interview': return { cls: 'fresh', label: 'Intervju' };
    case 'rejected': return { cls: 'sent', label: 'Avslag' };
    default: return null;
  }
}

export default function ResultsList({ search, creatingSearch, onOpenAd, onSearchChanged }) {
  const [rows, setRows] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [freshAt, setFreshAt] = useState(null);
  // Alla = the free candidate pool, Favoriter = what you starred,
  // Bedomda = what you actually paid to have judged.
  const [view, setView] = useState('alla');
  const [busyAd, setBusyAd] = useState(null);

  const load = useCallback(async () => {
    if (!search?.id) { setRows(null); return; }
    try {
      setRows(await api(`/api/searches/${search.id}/results`));
    } catch (e) { setError(e.message); }
  }, [search?.id]);

  useEffect(() => { setError(null); load(); }, [load]);

  // Scoring writes rows one ad at a time, so watch the per-search
  // beacon and pull the list only when the count actually moves.
  const version = useRef(null);
  usePoll(async () => {
    if (!search?.id) return;
    const { search: v } = await api(`/api/pulse?search=${search.id}`);
    if (v === version.current) return;
    const first = version.current === null;
    version.current = v;
    await load();
    if (!first) setFreshAt(Date.now());
  }, { interval: 3000, enabled: Boolean(search?.id) });

  // reset the beacon when switching searches
  useEffect(() => { version.current = null; }, [search?.id]);

  async function toggleScan() {
    await api(`/api/searches/${search.id}`, { method: 'PATCH', body: { scan_enabled: !search.scan_enabled } });
    onSearchChanged();
  }
  async function setInterval_(v) {
    await api(`/api/searches/${search.id}`, { method: 'PATCH', body: { scan_interval: v } });
    onSearchChanged();
  }
  async function scanNow() {
    setScanning(true);
    setError(null);
    try {
      // returns once the ads are queued, not once they are judged —
      // the queued cards show up immediately and fill in as scores land
      await api(`/api/searches/${search.id}/scan`, { method: 'POST' });
      await load();
      onSearchChanged();
    } catch (e) { setError(e.message); }
    setScanning(false);
  }

  // Free. Never enqueues a model call — that is the entire point of
  // keeping this separate from scoring.
  async function toggleStar(adId, on) {
    setBusyAd(adId);
    try {
      await api(`/api/searches/${search.id}/shortlist`, {
        method: 'PATCH', body: { ad_id: adId, shortlisted: on },
      });
      await load();
    } catch (e) { setError(e.message); }
    setBusyAd(null);
  }

  // The only button in the app that spends money on scoring, and it
  // spends it on exactly the ads named here.
  async function requestScore(adIds) {
    if (!adIds.length) return;
    setBusyAd(adIds[0]);
    try {
      await api(`/api/searches/${search.id}/score`, {
        method: 'POST', body: { ad_ids: adIds },
      });
      await load();
    } catch (e) { setError(e.message); }
    setBusyAd(null);
  }

  if (creatingSearch) {
    return (
      <div className="stage-view" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div className="loading-note">Beskriv din sökning i chatten till vänster</div>
      </div>
    );
  }
  if (!search) {
    return <div className="loading-note">Välj eller skapa en sökning</div>;
  }

  const all = (rows || []).filter((r) => !r.suppressed);
  const favourites = all.filter((r) => r.shortlisted);
  const scored = all.filter((r) => !r.pending);
  const candidates = all.filter((r) => !r.shortlisted && r.pending);
  const visible = view === 'favoriter' ? favourites : view === 'bedomda' ? scored : candidates;

  const pendingCount = all.filter((r) => r.score_requested && r.pending && r.attempts < 3).length;
  const scoredCount = scored.length;
  const expiringDrafts = visible.filter(
    (r) => r.application_status === 'drafted' && daysUntil(r.deadline) != null && daysUntil(r.deadline) <= 2
  );

  const ivRaw = search.scan_interval;
  const ivValue = typeof ivRaw === 'object' && ivRaw
    ? (ivRaw.days ? `${ivRaw.days} days` : ivRaw.hours ? `${ivRaw.hours} hours` : `${ivRaw.minutes || 15} minutes`)
    : ivRaw || '1 hours';

  return (
    <div className="stage-view" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="list-header">
        <div>
          <h2>Matchningar</h2>
          <div className="sub">
            <b>{candidates.length}</b> hittade · <b>{favourites.length}</b> favoriter · <b>{scoredCount}</b> bedömda{pendingCount > 0 && <> · <b>{pendingCount}</b> i kö</>}
            {' — '}{search.last_scanned_at ? `senast hämtad ${timeAgo(search.last_scanned_at)}` : 'ej hämtad än'}
            {freshAt && Date.now() - freshAt < 4000 && <span className="fresh-flash"> · nya resultat</span>}
          </div>
        </div>
        <div className="header-controls">
          <ApplyFilterSeg search={search} onChanged={onSearchChanged} />
          <div className={`autoscan${search.scan_enabled ? '' : ' paused'}`}>
            <span className="dot" />
            <label htmlFor="scanInterval">Auto-skanning</label>
            <select
              id="scanInterval"
              aria-label="Intervall"
              value={ivValue}
              disabled={!search.scan_enabled}
              onChange={(e) => setInterval_(e.target.value)}
            >
              <option value="15 minutes">15 min</option>
              <option value="1 hours">1 tim</option>
              <option value="6 hours">6 tim</option>
              <option value="1 days">1 dygn</option>
            </select>
            <button className="toggle" aria-pressed={search.scan_enabled} onClick={toggleScan}>
              {search.scan_enabled ? 'På' : 'Av'}
            </button>
          </div>
          <button className="btn" onClick={scanNow} disabled={scanning}>
            {scanning ? <>Hämtar<Dots label="Hämtar annonser" /></> : 'Skanna nu'}
          </button>
        </div>
      </div>

      {expiringDrafts.length > 0 && (
        <div className="deadline-bar">
          <span className="dtext">
            ⏱ <b>{expiringDrafts.length} utkast</b> gäller annonser som går ut inom 48 timmar
          </span>
          <button onClick={() => onOpenAd(expiringDrafts[0].ad_id)}>Visa dessa →</button>
        </div>
      )}

      {error && <div className="err-note">{error}</div>}

      <div className="view-tabs" role="tablist" aria-label="Vy">
        {[['alla', 'Hittade', candidates.length],
          ['favoriter', 'Favoriter', favourites.length],
          ['bedomda', 'Bedömda', scoredCount]].map(([id, label, n]) => (
          <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)}>
            {label} <i>{n}</i>
          </button>
        ))}
        {view === 'favoriter' && favourites.some((r) => r.pending && !r.score_requested) && (
          <button
            className="score-all"
            onClick={() => requestScore(favourites.filter((r) => r.pending && !r.score_requested).map((r) => r.ad_id))}
          >
            Bedöm alla {favourites.filter((r) => r.pending && !r.score_requested).length} →
          </button>
        )}
      </div>

      <div className="col-labels">
        <div>Poäng</div><div>Annons</div>
        <div className="lbl-meta">Detaljer</div>
        <div className="lbl-action" style={{ textAlign: 'right' }}>Åtgärd</div>
      </div>

      <div className="list-scroll">
        {rows === null && <div className="loading-note">Laddar<Dots /></div>}
        {rows !== null && !visible.length && (
          <div className="loading-note">
            {view === 'favoriter' ? 'Inga favoriter än — stjärnmärk annonser under Hittade'
              : view === 'bedomda' ? 'Inga bedömda än — favoritmärk annonser och tryck Bedöm'
              : 'Inga annonser än — hämta eller vänta på nästa auto-hämtning'}
          </div>
        )}
        {visible.map((r) => {
          const chip = statusChip(r);
          const exp = daysUntil(r.deadline);
          // one ad often flags the same tag twice ("Erfarenhet" for both
          // a years requirement and a seniority title) — dedupe for display
          const flags = [...new Set((r.flags || []).map((f) => f.tag).filter(Boolean))];
          // found by layer 1, no score yet — the ad itself is complete
          // and readable, only the judgement is outstanding
          const failed = r.pending && r.attempts >= 3;
          // Three distinct card states now, not two:
          //   unjudged  — no score, none requested. Read the ad yourself.
          //   waiting   — you asked for a score, it is being written.
          //   scored    — the number is in.
          const waiting = r.pending && r.score_requested && !failed;
          const unjudged = r.pending && !r.score_requested;
          return (
            <div key={r.ad_id} className={`card${r.pending ? ' unscored' : ''}`} onClick={() => onOpenAd(r.ad_id)}>
              <div className="score-col">
                {unjudged ? (
                  <button
                    className={`star${r.shortlisted ? ' on' : ''}`}
                    title={r.shortlisted ? 'Ta bort från favoriter' : 'Spara som favorit (kostar inget)'}
                    aria-pressed={Boolean(r.shortlisted)}
                    disabled={busyAd === r.ad_id}
                    onClick={(e) => { e.stopPropagation(); toggleStar(r.ad_id, !r.shortlisted); }}
                  >
                    {r.shortlisted ? '★' : '☆'}
                  </button>
                ) : r.pending ? (
                  <div className="score-num waiting" aria-label={failed ? 'Kunde inte bedömas' : 'Bedöms'}>
                    {failed ? '—' : <Dots label="Bedöms" />}
                  </div>
                ) : (
                  <>
                    <div className={`score-num ${scoreClass(r.score)}`}>{r.score}</div>
                    <div className={`score-bar ${scoreClass(r.score)}`} style={{ '--pct': `${r.score}%` }} />
                  </>
                )}
              </div>
              <div className="main-col">
                <div className="title-row">
                  <div className="job-title">{r.title}</div>
                  {chip && <div className={`status ${chip.cls}`}>{chip.label}</div>}
                </div>
                <div className="employer">{r.employer} — <span>{r.municipality || '—'}</span></div>
                {flags.length > 0 && (
                  <div className="tag-row">
                    {flags.map((t) => <span key={t} className="tag">{t.toUpperCase()}</span>)}
                  </div>
                )}
                <div className="reasoning">
                  {failed
                    ? <span className="rmute"><b>Kunde inte bedömas</b> — {r.last_error || 'modellen svarade inte'}</span>
                    : waiting
                      ? <span className="rmute">Bedömning pågår</span>
                      : unjudged
                        ? <span className="rmute">{r.snippet || 'Ingen annonstext'}</span>
                        : <><b>Bedömning:</b> {r.summary}</>}
                </div>
                {unjudged && (
                  <div className="cand-facts">
                    {r.occupation && <span>{r.occupation}</span>}
                    {r.working_hours && <span>{r.working_hours}</span>}
                    {r.employment_type && <span>{r.employment_type}</span>}
                  </div>
                )}
              </div>
              <div className="meta-col">
                <div className="row"><span>Publicerad</span><b>{fmtDate(r.published_at)}</b></div>
                <div className={`row expiry${exp != null && exp <= 3 ? ' soon' : ''}`}>
                  <span>Går ut</span><b>{exp == null ? '—' : exp <= 0 ? 'IDAG' : `${exp} DAGAR`}</b>
                </div>
                <div className="row"><span>Typ</span><b>{r.employer_type === 'public' ? 'OFFENTLIG' : r.employer_type === 'agency' ? 'BEMANNING' : 'PRIVAT'}</b></div>
                <div className="row"><span>Ansökan</span><b>{r.apply_email ? 'MEJL' : r.ats_vendor ? r.ats_vendor.toUpperCase() : 'LÄNK'}</b></div>
              </div>
              <div className="action-col">
                {unjudged ? (
                  <button
                    className="open-btn judge"
                    disabled={busyAd === r.ad_id}
                    title="Skickar den här annonsen till modellen — detta är det enda som kostar"
                    onClick={(e) => { e.stopPropagation(); requestScore([r.ad_id]); }}
                  >
                    Bedöm →
                  </button>
                ) : (
                  <button className="open-btn" onClick={(e) => { e.stopPropagation(); onOpenAd(r.ad_id); }}>
                    {r.application_status ? 'Visa →' : 'Skriv brev →'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
