'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, timeAgo, fmtDate } from '../lib/api.js';

const STATUS_META = {
  sent: { cls: 'awaiting', label: 'Väntar svar' },
  replied: { cls: 'replied', label: 'Svar inne' },
  interview: { cls: 'interview', label: 'Intervju' },
  rejected: { cls: 'rejected', label: 'Avslag' },
  ghosted: { cls: 'ghosted', label: 'Troligen ghostad' },
  withdrawn: { cls: 'rejected', label: 'Återkallad' },
};

function daysPastDeadline(deadline) {
  if (!deadline) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(deadline)) / 86400000));
}

// simple prior until enough outcomes exist for a learned model
// (ads.employer_type is populated on ingest for exactly this)
function odds(t) {
  if (t.status === 'rejected' || t.status === 'withdrawn') return { pct: 0, label: 'Avslutad', done: true };
  if (t.status === 'interview') return { pct: 88, label: 'Hög' };
  if (t.status === 'replied') return { pct: 75, label: 'God' };
  const past = daysPastDeadline(t.deadline);
  let base = t.employer_type === 'public' ? 70 : t.employer_type === 'agency' ? 40 : 55;
  if (past > 30) base = 5;
  else if (past > 14) base = Math.min(base, 25);
  else if (past > 7) base = Math.round(base * 0.7);
  const label = base >= 60 ? 'God' : base >= 25 ? 'Måttlig' : 'Mycket låg';
  return { pct: base, label };
}

function oddsNote(t) {
  const past = daysPastDeadline(t.deadline);
  if (t.status === 'rejected') return { text: 'Ansökan avslutad — arbetsgivaren har svarat.', warn: false };
  if (t.status === 'interview') return { text: 'Arbetsgivaren har svarat och väntar på dig.', warn: false };
  if (past > 30) return { text: `${past} dagar sedan sista ansökningsdag. Tjänsten är sannolikt tillsatt.`, warn: true };
  if (past > 14) return { text: `${past} dagar sedan sista ansökningsdag. Svarschansen sjunker snabbt efter två veckor.`, warn: true };
  if (past > 0) return { text: `${past} dagar sedan sista ansökningsdag. Många arbetsgivare svarar först efter deadline.`, warn: false };
  return { text: `Ansökningstiden pågår${t.deadline ? ` till ${fmtDate(t.deadline)}` : ''}. De flesta svarar efter sista ansökningsdag.`, warn: false };
}

const oddsCls = (p) => (p >= 60 ? '' : p >= 25 ? 'mid' : 'low');

export default function Inbox({ onFindSimilar }) {
  const [threads, setThreads] = useState([]);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState('all');
  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState(null);
  const [openMsgs, setOpenMsgs] = useState({});
  const [composerText, setComposerText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setThreads(await api('/api/inbox'));
      setStats(await api('/api/stats'));
    } catch (e) { setError(e.message); }
  }, []);

  const loadThread = useCallback(async (id) => {
    if (!id) return;
    try {
      const t = await api(`/api/inbox/${id}`);
      setThread(t);
      setOpenMsgs((o) => {
        const next = { ...o };
        const last = t.messages[t.messages.length - 1];
        if (last) next[last.id] = true;
        return next;
      });
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => { loadThread(activeId); }, [activeId, loadThread]);

  const filtered = threads.filter((t) => {
    if (filter === 'unread') return Number(t.pending_suggestions) > 0;
    if (filter === 'awaiting') return t.status === 'sent';
    if (filter === 'ghosted') return t.status === 'ghosted';
    return true;
  });

  async function sendReply(body, suggestedReplyId = null) {
    if (!body?.trim() || !thread) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/inbox/${thread.id}/reply`, {
        method: 'POST',
        body: { body, suggestedReplyId },
      });
      setComposerText('');
      await loadThread(thread.id);
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function dismissSuggestion(id) {
    await api(`/api/suggestions/${id}`, { method: 'PATCH' });
    await loadThread(thread.id);
  }

  async function toggleFollowup() {
    await api(`/api/applications/${thread.id}`, {
      method: 'PATCH', body: { followup_enabled: !thread.followup_enabled },
    });
    await loadThread(thread.id);
  }

  const calib = stats?.calibration;

  return (
    <div className="inbox">
      <div className="thread-list">
        <div className="inbox-head">
          <div className="idx">03 / Ansökningar</div>
          <h2>Inkorg</h2>
          <div className="inbox-filters">
            {[['all', 'Alla'], ['unread', 'Att göra'], ['awaiting', 'Väntar svar'], ['ghosted', 'Ghostade']].map(([k, label]) => (
              <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
        </div>

        <div className="stats-strip">
          {calib?.ready ? (
            <>
              <span className="stitle">Träffsäkerhet · {calib.total} ansökningar</span>
              {calib.bands.map((b) => (
                <div className="calib-row" key={b.band}>
                  <span className="band">{b.band}</span>
                  <span className={`ctrack ${b.rate >= 30 ? '' : b.rate >= 15 ? 'mid' : 'low'}`} style={{ '--rate': `${b.rate}%` }} />
                  <span className="cnum">{b.rate}% svar</span>
                </div>
              ))}
            </>
          ) : (
            <>
              <span className="stitle">Träffsäkerhet</span>
              <div className="calib-note">
                Visas efter <b>{calib?.needed ?? 20} skickade ansökningar</b>
                {calib ? ` (${calib.total} hittills)` : ''} — procent på små tal vilseleder.
              </div>
            </>
          )}
        </div>

        <div className="threads">
          {filtered.map((t) => {
            const meta = STATUS_META[t.status] || STATUS_META.sent;
            const o = odds(t);
            const unread = Number(t.pending_suggestions) > 0;
            return (
              <button
                key={t.id}
                className={`thread-item${unread ? ' unread' : ''}`}
                aria-current={t.id === activeId}
                onClick={() => setActiveId(t.id)}
              >
                <span className="ti-top">
                  <span className="ti-title">{t.title}</span>
                  <span className="ti-when">{timeAgo(t.last_msg_at || t.sent_at)}</span>
                </span>
                <span className="ti-emp">{t.employer}</span>
                <span className="ti-foot"><span className={`st ${meta.cls}`}>{meta.label}</span></span>
                <span className={`odds${o.done ? ' done' : ''}`}>
                  <span className="odds-top"><span>Svarschans</span><b>{o.done ? '—' : o.label}</b></span>
                  <span className={`odds-track ${oddsCls(o.pct)}`} style={{ '--odds': `${o.done ? 100 : o.pct}%` }} />
                </span>
              </button>
            );
          })}
          {!filtered.length && <div className="empty-thread">Inga ansökningar matchar filtret</div>}
        </div>
      </div>

      <div className="thread-view">
        {!thread ? (
          <div className="empty-thread">{error || 'Välj en ansökan till vänster'}</div>
        ) : (
          <ThreadDetail
            thread={thread}
            openMsgs={openMsgs}
            setOpenMsgs={setOpenMsgs}
            composerText={composerText}
            setComposerText={setComposerText}
            busy={busy}
            error={error}
            onSendReply={sendReply}
            onDismiss={dismissSuggestion}
            onToggleFollowup={toggleFollowup}
            onFindSimilar={onFindSimilar}
          />
        )}
      </div>
    </div>
  );
}

function ThreadDetail({ thread: t, openMsgs, setOpenMsgs, composerText, setComposerText, busy, error, onSendReply, onDismiss, onToggleFollowup, onFindSimilar }) {
  const meta = STATUS_META[t.status] || STATUS_META.sent;
  const o = odds(t);
  const note = oddsNote(t);
  const suggestion = (t.suggestions || [])[0] || null;

  return (
    <>
      <div className="tv-head">
        <div>
          <div className="jt">{t.title}</div>
          <div className="je">
            {t.employer} — <b>{t.sent_to || '—'}</b>
            {t.sent_at && <> · ansökt <b>{fmtDate(t.sent_at)}</b></>}
          </div>
        </div>
        <div className="tv-actions">
          {t.search_deleted_at || !t.origin_search_id ? (
            <button className="ref-btn gone" disabled title="Sökningen är borttagen">↩ Sökning borttagen</button>
          ) : (
            <button className="ref-btn" onClick={() => onFindSimilar(t.origin_search_id)}>↩ Hitta liknande jobb</button>
          )}
        </div>
      </div>

      <div className="tv-strip">
        <div className="strip-item">Status<b>{meta.label}</b></div>
        <div className="strip-item">Sista ansökningsdag<b>{fmtDate(t.deadline)}</b></div>
        <div className="strip-item strip-odds">
          <div className={`odds${o.done ? ' done' : ''}`}>
            <div className="odds-top"><span>Sannolikhet för svar</span><b>{o.done ? '—' : `${o.label} · ${o.pct}%`}</b></div>
            <div className={`odds-track ${oddsCls(o.pct)}`} style={{ '--odds': `${o.done ? 100 : o.pct}%` }} />
          </div>
          <div className={`odds-note${note.warn ? ' warn' : ''}`}>{note.text}</div>
        </div>
      </div>

      <div className="tv-scroll">
        {(t.messages || []).map((m) => {
          const mine = m.direction === 'outbound';
          const open = !!openMsgs[m.id];
          return (
            <div key={m.id} className={`tmsg ${mine ? 'mine' : 'theirs'}${open ? ' is-open' : ''}`}>
              <div className="tmsg-head" onClick={() => setOpenMsgs((s) => ({ ...s, [m.id]: !open }))}>
                <span className="tmsg-who">
                  {mine ? 'Du' : m.from_name || m.from_addr}
                  <span className="role">{mine ? (m.in_reply_to ? 'Svar' : 'Ansökan') : t.employer}</span>
                </span>
                <span className="tmsg-meta">
                  {new Date(m.sent_at).toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {' '}<span className="caret">›</span>
                </span>
              </div>
              <div className="tmsg-preview">{(m.body_text || '').slice(0, 110)}</div>
              <div className="tmsg-body">
                {(m.body_text || '').split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
              </div>
            </div>
          );
        })}

        {t.prep && (
          <details className="prep" open>
            <summary className="prep-head" style={{ listStyle: 'none' }}>
              <span>◆ Inför intervjun</span>
              <span>genererat {timeAgo(t.prep.created_at)}</span>
            </summary>
            <div className="prep-body" style={{ display: 'block' }}>
              <h5>Troliga frågor</h5>
              <ul>{(t.prep.questions || []).map((q, i) => <li key={i}>{q}</li>)}</ul>
              {t.prep.claimed_note && (
                <>
                  <h5>Vad du påstod i brevet</h5>
                  <div className="claimed"><b>Var beredd att backa upp</b>{t.prep.claimed_note}</div>
                </>
              )}
              {t.prep.gaps?.length > 0 && (
                <>
                  <h5>Luckor värda att förbereda</h5>
                  <ul>{t.prep.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
                </>
              )}
            </div>
          </details>
        )}

        {t.status === 'sent' && (
          <div className="followup">
            Uppföljning: utkast <b>{t.followup_days} dagar</b> efter deadline
            {t.followup_sent_at && <> · skickad {fmtDate(t.followup_sent_at)}</>}
            <button className="fu-toggle" aria-pressed={t.followup_enabled} onClick={onToggleFollowup}>
              {t.followup_enabled ? 'På' : 'Av'}
            </button>
          </div>
        )}

        {suggestion && (
          <div className="suggest">
            <div className="suggest-head">
              <span>◆ {suggestion.kind === 'followup' ? 'Föreslagen uppföljning' : 'Föreslaget svar'}</span>
              <span>genererat {timeAgo(suggestion.created_at)}</span>
            </div>
            <div className="suggest-body">
              {suggestion.body.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
            </div>
            <div className="suggest-acts">
              <button className="primary" disabled={busy} onClick={() => onSendReply(suggestion.body, suggestion.id)}>
                {busy ? 'Skickar…' : 'Skicka detta →'}
              </button>
              <button onClick={() => setComposerText(suggestion.body)}>Redigera först</button>
              <button onClick={() => onDismiss(suggestion.id)}>Släng</button>
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        {error && <div className="err-note" style={{ margin: '0 0 8px' }}>{error}</div>}
        <div className="composer-box">
          <textarea
            rows={2}
            placeholder="Skriv ett svar…"
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
          />
          <button className="composer-send" disabled={busy} onClick={() => onSendReply(composerText)}>
            Skicka
          </button>
        </div>
        <div className="composer-note">
          Skickas från {t.sent_from || 'ditt Gmail-konto'} · svar hamnar i samma tråd · inget skickas utan att du klickar
        </div>
      </div>
    </>
  );
}
