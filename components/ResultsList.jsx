'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, daysUntil, timeAgo } from '../lib/api.js';

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

  const load = useCallback(async () => {
    if (!search?.id) { setRows(null); return; }
    try {
      setRows(await api(`/api/searches/${search.id}/results`));
    } catch (e) { setError(e.message); }
  }, [search?.id]);

  useEffect(() => {
    setError(null);
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

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
      await api(`/api/searches/${search.id}/scan`, { method: 'POST' });
      await load();
      onSearchChanged();
    } catch (e) { setError(e.message); }
    setScanning(false);
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

  const visible = (rows || []).filter((r) => !r.suppressed);
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
            <b>{visible.length}</b> bedömda annonser — {search.last_scanned_at ? `senast skannad ${timeAgo(search.last_scanned_at)}` : 'ej skannad än'}
          </div>
        </div>
        <div className="header-controls">
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
            {scanning ? 'Skannar…' : 'Skanna nu'}
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

      <div className="col-labels">
        <div>Poäng</div><div>Annons</div>
        <div className="lbl-meta">Detaljer</div>
        <div className="lbl-action" style={{ textAlign: 'right' }}>Åtgärd</div>
      </div>

      <div className="list-scroll">
        {rows === null && <div className="loading-note">Laddar…</div>}
        {rows !== null && !visible.length && (
          <div className="loading-note">Inga bedömda annonser än — skanna eller vänta på nästa auto-skanning</div>
        )}
        {visible.map((r) => {
          const chip = statusChip(r);
          const exp = daysUntil(r.deadline);
          const flags = (r.flags || []).map((f) => f.tag).filter(Boolean);
          return (
            <div key={r.ad_id} className="card" onClick={() => onOpenAd(r.ad_id)}>
              <div className="score-col">
                <div className={`score-num ${scoreClass(r.score)}`}>{r.score}</div>
                <div className={`score-bar ${scoreClass(r.score)}`} style={{ '--pct': `${r.score}%` }} />
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
                <div className="reasoning"><b>Bedömning:</b> {r.summary}</div>
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
                <button className="open-btn" onClick={(e) => { e.stopPropagation(); onOpenAd(r.ad_id); }}>
                  {r.application_status ? 'Visa →' : 'Skriv brev →'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
