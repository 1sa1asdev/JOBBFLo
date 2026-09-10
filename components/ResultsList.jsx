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
    case 'sent': return { cls: 'sent', label: r.sent_by === 'external' ? 'Ansökt via länk' : 'Skickad' };
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
  const [open, setOpen] = useState(() => new Set());  // ad_ids with the text expanded
  const [counts, setCounts] = useState({ hittade: 0, favoriter: 0, bedomda: 0, iKon: 0 });
  const [home, setHome] = useState(null);
  const [maxKm, setMaxKm] = useState(null);   // null = ingen gräns
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef(null);
  const scrollBox = useRef(null);
  const PAGE = 60;

  // Reloads page 0 for the current view. Scrolling appends via loadMore.
  // One place that builds the query, so the first page and every
  // scrolled page always agree on view, filters and sort.
  const qs = useCallback((off) => new URLSearchParams({
    view,
    apply: search?.apply_filter || 'any',
    limit: String(PAGE),
    offset: String(off),
    ...(maxKm ? { maxkm: String(maxKm), sort: 'distance' } : {}),
  }).toString(), [view, search?.apply_filter, maxKm]);

  const load = useCallback(async () => {
    if (!search?.id) { setRows(null); return; }
    try {
      const d = await api(`/api/searches/${search.id}/results?${qs(0)}`);
      setRows(d.rows);
      setCounts(d.counts);
      setTotal(d.total);
      setHasMore(d.hasMore);
      setHome(d.home);
    } catch (e) { setError(e.message); }
  }, [search?.id, view, search?.apply_filter, maxKm, qs]);

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

  const loadMore = useCallback(async () => {
    if (!search?.id || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const d = await api(`/api/searches/${search.id}/results?${qs(rows?.length || 0)}`);
      // de-dupe on ad_id: a concurrent scan can insert rows above the
      // current offset and shift the window, which would otherwise
      // repeat an ad on the seam between pages
      setRows((prev) => {
        const seen = new Set((prev || []).map((r) => r.ad_id));
        return [...(prev || []), ...d.rows.filter((r) => !seen.has(r.ad_id))];
      });
      setTotal(d.total);
      setHasMore(d.hasMore);
    } catch (e) { setError(e.message); }
    setLoadingMore(false);
  }, [search?.id, view, search?.apply_filter, maxKm, qs, rows?.length, hasMore, loadingMore]);

  // Infinite scroll via a plain scroll listener, deliberately NOT
  // IntersectionObserver. IO delivers no callbacks while the document
  // is hidden, which is the same class of trap as requestAnimationFrame
  // — this project has now been bitten by it four times. Scroll events
  // fire regardless of visibility, so this works in a background tab
  // and, just as importantly, can actually be tested in one.
  useEffect(() => {
    const box = scrollBox.current;
    if (!box || !hasMore) return undefined;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      setTimeout(() => { ticking = false; }, 150);
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 400) loadMore();
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  }, [loadMore, hasMore]);

  // If a page doesn't fill the container there is nothing to scroll, so
  // the handler above can never fire and the list would stall short of
  // the total. Top it up until the box overflows or the set runs out.
  useEffect(() => {
    const box = scrollBox.current;
    if (!box || !hasMore || loadingMore) return;
    if (box.scrollHeight <= box.clientHeight + 40) loadMore();
  }, [rows, hasMore, loadingMore, loadMore]);

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

  // Records that the link was opened, then lets the browser follow it.
  // Deliberately not awaited: the navigation must not wait on our own
  // bookkeeping, and a failed write only means the button stays locked
  // — which is the safe direction for a control that hides an ad.
  function openApplyLink(adId) {
    api(`/api/ads/${adId}/opened`, { method: 'POST' })
      .then(() => load())
      .catch(() => { /* the link still opens; the button stays locked */ });
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

  // Judge again against the new criteria. Clearing the score is what
  // puts the row back in the scoring queue; the user asked for this
  // explicitly, so it is the one place a paid verdict is discarded.
  async function rescore(adId) {
    setBusyAd(adId);
    try {
      await api(`/api/searches/${search.id}/score`, {
        method: 'POST', body: { ad_ids: [adId], rescore: true },
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

  // Records an application made on the employer's own site. Costs
  // nothing, sends nothing, and needs no letter — for a link-only ad
  // the letter is usually never used anyway.
  async function markApplied(adId) {
    setBusyAd(adId);
    setError(null);
    try {
      await api(`/api/ads/${adId}/applied`, {
        method: 'POST', body: { searchId: search?.id || null },
      });
      await load();
    } catch (e) { setError(e.message); }
    setBusyAd(null);
  }

  async function undoApplied(adId) {
    setBusyAd(adId);
    setError(null);
    try {
      await api(`/api/ads/${adId}/applied`, { method: 'DELETE' });
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

  // The server already filtered to the active view, so `rows` IS the
  // visible page. Counts come from the server too — a client-side count
  // would only ever describe the page, not the set.
  const visible = rows || [];
  const unscoredFavs = visible.filter((r) => r.pending && !r.score_requested);
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
            visar <b>{visible.length}</b> av <b>{total}</b>{counts.iKon > 0 && <> · <b>{counts.iKon}</b> i kö</>}
            {/* "senast hämtad för 52 min sedan" answers when, never
                whether. A first sweep can run a long time, and the only
                visible difference between working and stalled was a
                timestamp that also stands still — so it read as broken.
                These are three distinct states and now say so. */}
            {' — '}{search.fetch_done_at
              ? (search.scan_enabled
                  ? <>bevakar nya annonser · senast {timeAgo(search.last_scanned_at)}</>
                  : <>bevakning av · senast {timeAgo(search.last_scanned_at)}</>)
              : search.fetch_total
                ? <><span className="scanning">söker igenom</span>{' '}
                    <b>{Math.min(search.fetch_offset || 0, search.fetch_total)}</b> av{' '}
                    <b>{search.fetch_total}</b></>
                : <span className="scanning">söker …</span>}
            {maxKm && <> · <b>inom {maxKm} km</b></>}
            {counts.hittadeUtanFilter > counts.hittade
              ? ` · ${counts.hittadeUtanFilter - counts.hittade} dolda av ansökningsfiltret`
              : ''}
            {search.fetch_total ? ` · ${search.fetch_total} träffar hos AF` : ''}
            {freshAt && Date.now() - freshAt < 4000 && <span className="fresh-flash"> · nya resultat</span>}
          </div>
        </div>
        <div className="header-controls">
          <ApplyFilterSeg search={search} onChanged={onSearchChanged} />
          {home && (
            <div className="applyseg" title={`Fågelvägen från ${home.label}`}>
              <span className="as-label">Inom</span>
              <div className="ct-seg" role="group" aria-label="Max avstånd">
                {[[null, 'Alla'], [2, '2 km'], [5, '5 km'], [10, '10 km'], [30, '30 km']]
                  .map(([km, label]) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={maxKm === km}
                    onClick={() => setMaxKm(km)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
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

      {/* A requirement JobSearch rejected is indistinguishable from a
          filter that does nothing — unless we say so. */}
      {search.dropped_filters?.length > 0 && (
        <div className="dropped-note">
          ⚠ <b>{search.dropped_filters.join(', ')}</b> gav noll träffar hos Arbetsförmedlingen
          och användes inte — resultatet är bredare än du bad om.
        </div>
      )}

      <div className="view-tabs" role="tablist" aria-label="Vy">
        {[['alla', 'Hittade', counts.hittade],
          ['favoriter', 'Favoriter', counts.favoriter],
          ['bedomda', 'Bedömda', counts.bedomda]].map(([id, label, n]) => (
          <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)}>
            {label} <i>{n}</i>
          </button>
        ))}
        {view === 'favoriter' && unscoredFavs.length > 0 && (
          <button className="score-all" onClick={() => requestScore(unscoredFavs.map((r) => r.ad_id))}>
            Bedöm alla {unscoredFavs.length} →
          </button>
        )}
      </div>

      <div className="col-labels">
        <div>Poäng</div><div>Annons</div>
        <div className="lbl-meta">Detaljer</div>
        <div className="lbl-action" style={{ textAlign: 'right' }}>Åtgärd</div>
      </div>

      <div className="list-scroll" ref={scrollBox}>
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
          // Application state is its own axis: an ad can be scored AND
          // sent, and once it is sent the card must say so rather than
          // keep offering to write the letter that is already in the
          // employer's inbox.
          const isSent = ['sent', 'replied', 'interview', 'rejected']
            .includes(r.application_status);
          const isDraft = r.application_status === 'drafted';
          return (
            <div
              key={r.ad_id}
              className={`card${r.pending ? ' unscored' : ''}${isSent ? ' is-sent' : ''}`}
              onClick={() => onOpenAd(r.ad_id)}
            >
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
                {/* Clamped to two lines by default. The card was 295px
                    tall, which put two ads on a 900px screen out of 662
                    found — the list you triage in was showing you less
                    than one percent of itself at a time.
                    Clicking the text alone expands it; clicking anywhere
                    else still opens the ad, which is where the full
                    description lives anyway. */}
                <div
                  className={`reasoning${open.has(r.ad_id) ? '' : ' clamp'}`}
                  title={open.has(r.ad_id) ? 'Klicka för att fälla ihop' : 'Klicka för att läsa mer'}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((s) => {
                      const next = new Set(s);
                      if (next.has(r.ad_id)) next.delete(r.ad_id); else next.add(r.ad_id);
                      return next;
                    });
                  }}
                >
                  {isSent
                    ? <span className="rsent">
                        {r.sent_by === 'external' ? 'Ansökt via annonsens länk' : 'Ansökan skickad'}
                        {r.sent_at ? ` ${fmtDate(r.sent_at)}` : ''}
                        {r.application_status === 'replied' && ' — svar inne, se Inkorgen'}
                        {r.application_status === 'interview' && ' — intervjuförfrågan, se Inkorgen'}
                        {r.application_status === 'rejected' && ' — avslag'}
                      </span>
                    : failed
                    ? <span className="rmute"><b>Kunde inte bedömas</b> — {r.last_error || 'modellen svarade inte'}</span>
                    : waiting
                      ? <span className="rmute">Bedömning pågår</span>
                      : unjudged
                        ? <span className="rmute">{r.snippet || 'Ingen annonstext'}</span>
                        : <>
                        {r.stale && (
                          <span className="stale-mark" title="Kriterierna ändrades efter den här bedömningen">
                            ÄLDRE KRITERIER
                          </span>
                        )}
                        <b>Bedömning:</b> {r.summary}
                      </>}
                </div>
                <div className={`cand-facts${open.has(r.ad_id) ? '' : ' clamp'}`}>
                  {/* Distance first: it is the fact most likely to rule an
                      ad out, and it costs nothing to compute. */}
                  {r.distance_km != null && (
                    <span className={`km${r.distance_km > 30 ? ' far' : ''}`}>
                      {r.distance_km} km
                    </span>
                  )}
                  {home && r.distance_km == null && r.lat == null && (
                    <span className="km unknown" title="Annonsen saknar koordinater">
                      avstånd okänt
                    </span>
                  )}
                  {r.street && <span>{r.street}</span>}
                  {unjudged && r.occupation && <span>{r.occupation}</span>}
                  {unjudged && r.working_hours && <span>{r.working_hours}</span>}
                  {unjudged && r.employment_type && <span>{r.employment_type}</span>}
                </div>
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
                {isSent ? (
                  <div className="sent-mark">
                    <b>{r.sent_by === 'external' ? '✓ Ansökt' : '✓ Skickad'}</b>
                    {r.sent_at && <span>{fmtDate(r.sent_at)}</span>}
                    <button className="open-btn" onClick={(e) => { e.stopPropagation(); onOpenAd(r.ad_id); }}>
                      Visa →
                    </button>
                    {/* Undo, because one click marked it and one click
                        should unmark it. Refused server-side once a
                        letter or a mail thread exists. */}
                    {r.sent_by === 'external' && (
                      <button
                        className="undo-btn"
                        disabled={busyAd === r.ad_id}
                        onClick={(e) => { e.stopPropagation(); undoApplied(r.ad_id); }}
                      >
                        Ångra
                      </button>
                    )}
                  </div>
                ) : unjudged ? (
                  <button
                    className="open-btn judge"
                    disabled={busyAd === r.ad_id}
                    title="Skickar den här annonsen till modellen — detta är det enda som kostar"
                    onClick={(e) => { e.stopPropagation(); requestScore([r.ad_id]); }}
                  >
                    {busyAd === r.ad_id ? <>Köar<Dots label="Köar" /></> : 'Bedöm →'}
                  </button>
                ) : waiting ? (
                  <button className="open-btn" disabled>Bedöms<Dots label="Bedöms" /></button>
                ) : r.stale ? (
                  <button
                    className="open-btn judge"
                    disabled={busyAd === r.ad_id}
                    title="Bedöm om mot de nya kriterierna"
                    onClick={(e) => { e.stopPropagation(); rescore(r.ad_id); }}
                  >
                    Bedöm om →
                  </button>
                ) : (
                  <button className="open-btn" onClick={(e) => { e.stopPropagation(); onOpenAd(r.ad_id); }}>
                    {isDraft ? 'Granska utkast →' : 'Skriv brev →'}
                  </button>
                )}

                {/* Link-only ads are applied to on the employer's site,
                    so the app never learns it happened. This is the only
                    way such a job stops looking untouched — and it sits
                    outside the chain above because you can apply to a job
                    whether or not you ever had it judged. */}
                {!isSent && !r.apply_email && r.apply_url && (() => {
                  // Off until the app has seen something. Marking an ad
                  // applied hides it from the list for good, and the
                  // application itself happens on the employer's site
                  // where nothing here can watch it — so the button
                  // needs a fact behind it: the link was opened from
                  // this app, or a letter exists for the ad. Until then
                  // the link itself is the action, and it is the thing
                  // that unlocks the button.
                  const kanMarkas = r.link_opened || r.has_letter;
                  return kanMarkas ? (
                    <button
                      className="applied-btn"
                      disabled={busyAd === r.ad_id}
                      title="Registrera att du sökt via annonsens länk — inget mejl skickas"
                      onClick={(e) => { e.stopPropagation(); markApplied(r.ad_id); }}
                    >
                      {busyAd === r.ad_id ? <Dots label="Sparar" /> : '✓ Sökt'}
                    </button>
                  ) : (
                    <a
                      className="applied-btn as-link"
                      href={r.apply_url}
                      target="_blank"
                      rel="noreferrer"
                      title="Öppnar annonsen. När du varit där kan du markera den som sökt."
                      onClick={(e) => { e.stopPropagation(); openApplyLink(r.ad_id); }}
                    >
                      Öppna annons ↗
                    </a>
                  );
                })()}
              </div>
            </div>
          );
        })}
        {hasMore && (
          <div ref={sentinel} className="scroll-sentinel">
            {loadingMore ? <>Hämtar fler<Dots label="Hämtar fler" /></> : `${total - visible.length} till`}
          </div>
        )}
        {!hasMore && visible.length > 0 && (
          <div className="scroll-sentinel end">Inga fler — {total} totalt</div>
        )}
      </div>
    </div>
  );
}
