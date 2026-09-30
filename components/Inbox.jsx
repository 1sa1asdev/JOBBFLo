'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, timeAgo, fmtDate } from '../lib/api.js';
import { usePoll } from '../lib/usePoll.js';
import LiveDot from './LiveDot';
import { useNotify } from '../lib/useNotify.js';
import Dots from './Dots';

const STATUS_META = {
  sent: { cls: 'awaiting', label: 'Väntar svar' },
  replied: { cls: 'replied', label: 'Svar inne' },
  interview: { cls: 'interview', label: 'Intervju' },
  rejected: { cls: 'rejected', label: 'Avslag' },
  ghosted: { cls: 'ghosted', label: 'Troligen ghostad' },
  withdrawn: { cls: 'rejected', label: 'Återkallad' },
  // A letter that bounced. Kept apart from 'Avslag' because the
  // employer never saw it — 19 of 124 rejections were this.
  undeliverable: { cls: 'rejected', label: 'Kom inte fram' },
};

function daysPastDeadline(deadline) {
  if (!deadline) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(deadline)) / 86400000));
}

// simple prior until enough outcomes exist for a learned model
// (ads.employer_type is populated on ingest for exactly this)
function odds(t) {
  if (t.status === 'rejected' || t.status === 'withdrawn') return { pct: 0, label: 'Avslutad', done: true };
  if (t.status === 'undeliverable') return { pct: 0, label: 'Kom inte fram', done: true };
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
  if (t.status === 'undeliverable') return { text: 'Brevet kom aldrig fram — adressen fungerade inte och har tagits bort från annonsen.', warn: true };
  if (t.status === 'interview') return { text: 'Arbetsgivaren har svarat och väntar på dig.', warn: false };
  if (past > 30) return { text: `${past} dagar sedan sista ansökningsdag. Tjänsten är sannolikt tillsatt.`, warn: true };
  if (past > 14) return { text: `${past} dagar sedan sista ansökningsdag. Svarschansen sjunker snabbt efter två veckor.`, warn: true };
  if (past > 0) return { text: `${past} dagar sedan sista ansökningsdag. Många arbetsgivare svarar först efter deadline.`, warn: false };
  return { text: `Ansökningstiden pågår${t.deadline ? ` till ${fmtDate(t.deadline)}` : ''}. De flesta svarar efter sista ansökningsdag.`, warn: false };
}

const oddsCls = (p) => (p >= 60 ? '' : p >= 25 ? 'mid' : 'low');

// ------------------------------------------------------------
// A campaign heading in the auto-inbox.
//
// Auto-applied letters go out without anyone reading them first, so a
// flat list of replies answers "what came back" but not "which of my
// campaigns did this". Grouping is the whole point: each campaign is a
// separate bet about what to apply for, and its replies are the only
// evidence about whether that bet is paying off.
//
// The purpose is editable in place because it is exactly the thing you
// discover was wrong — reading five off-target replies tells you the
// criteria were off, and the fix belongs where you noticed it rather
// than three tabs away. Saving re-runs layer 1 and re-scans; favourites
// and paid verdicts survive (see the PATCH handler for why).
// ------------------------------------------------------------
function CampaignHead({ group, collapsed, onToggle, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name || '');
  const [purpose, setPurpose] = useState(group.purpose || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // A deleted search has nothing left to edit — its threads are shown
  // for history, not for steering.
  const orphan = !group.id || group.deleted;

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api('/api/autoapply', {
        method: 'PATCH',
        body: { searchId: group.id, name, criteria: purpose },
      });
      // Saved, but the filters could not be rebuilt — the campaign is
      // running on the old ones. Worth saying out loud rather than
      // letting the editor close as if nothing happened.
      if (r?.warning) setErr(r.warning); else setEditing(false);
      onSaved?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className={`camp-head${collapsed ? ' collapsed' : ''}`}>
      <div className="camp-top">
        <button className="camp-toggle" onClick={onToggle} aria-expanded={!collapsed}>
          <span className="caret">{collapsed ? '▸' : '▾'}</span>
          <span className="camp-name">{group.name}</span>
          {group.deleted && <span className="camp-gone">borttagen</span>}
          <span className="camp-count">{group.threads.length}</span>
        </button>
        {!orphan && (
          <button className="camp-edit" onClick={() => setEditing(!editing)}
            title="Ändra vad kampanjen söker efter">
            {editing ? 'Avbryt' : 'Ändra syfte'}
          </button>
        )}
      </div>

      {!collapsed && (group.replies > 0 || group.paused) && (
        <div className="camp-stats">
          {group.replies > 0 && <span className="camp-stat">{group.replies} svar</span>}
          {group.todo > 0 && <span className="camp-stat todo">{group.todo} att göra</span>}
          {group.paused && <span className="camp-stat warn">Pausad: {group.paused}</span>}
        </div>
      )}

      {editing ? (
        <div className="camp-editor">
          <input className="ct-input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Kampanjens namn" />
          <textarea className="ct-input" rows={3} value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Vad kampanjen ska söka efter" />
          <div className="camp-editor-note">
            Sparas och söks om direkt. Favoriter och betalda bedömningar behålls —
            bara okontrollerade kandidater från det gamla syftet rensas.
          </div>
          {err && <div className="err-note">{err}</div>}
          <button className="btn" onClick={save} disabled={busy || !name.trim() || !purpose.trim()}>
            {busy ? <>Sparar<Dots label="Sparar" /></> : 'Spara syfte'}
          </button>
        </div>
      ) : (
        !collapsed && group.purpose && <div className="camp-purpose">{group.purpose}</div>
      )}
    </div>
  );
}

function ThreadItem({ t, active, onClick }) {
  const meta = STATUS_META[t.status] || STATUS_META.sent;
  const o = odds(t);
  const unread = Number(t.pending_suggestions) > 0;
  return (
    <button
      className={`thread-item${unread ? ' unread' : ''}`}
      aria-current={active}
      onClick={onClick}
    >
      <span className="ti-top">
        <span className="ti-title">{t.title}</span>
        <span className="ti-when">{timeAgo(t.last_msg_at || t.sent_at)}</span>
      </span>
      <span className="ti-emp">{t.employer}</span>
      <span className="ti-foot">
        <span className={`st ${meta.cls}`}>{meta.label}</span>
        {/* No message_id and no thread — a reply here will arrive
            somewhere this app cannot follow, so say so plainly rather
            than let the empty thread read as silence from the employer. */}
        {t.sent_by === 'external' && <span className="st ext">Via länk</span>}
      </span>
      <span className={`odds${o.done ? ' done' : ''}`}>
        <span className="odds-top"><span>Svarschans</span><b>{o.done ? '—' : o.label}</b></span>
        <span className={`odds-track ${oddsCls(o.pct)}`} style={{ '--odds': `${o.done ? 100 : o.pct}%` }} />
      </span>
    </button>
  );
}

// Threads -> campaigns, keeping the order the inbox already sorted them
// in (most recent activity first), so the campaign that just heard back
// sits at the top. Applications whose search was deleted keep their own
// group rather than vanishing: origin_search_id is ON DELETE SET NULL
// precisely so this degrades instead of breaking.
function groupByCampaign(threads) {
  const map = new Map();
  for (const t of threads) {
    const key = t.origin_search_id || 'ingen';
    if (!map.has(key)) {
      map.set(key, {
        id: t.origin_search_id || null,
        name: t.origin_search_id ? (t.search_name || 'Namnlös kampanj') : 'Utan kampanj',
        purpose: t.campaign_purpose || null,
        deleted: Boolean(t.search_deleted_at),
        paused: t.campaign_paused || null,
        threads: [], replies: 0, todo: 0,
      });
    }
    const g = map.get(key);
    g.threads.push(t);
    if (t.status !== 'sent') g.replies += 1;
    if (Number(t.pending_suggestions) > 0) g.todo += 1;
  }
  return [...map.values()];
}

export default function Inbox({ onFindSimilar, source = 'user' }) {
  const [threads, setThreads] = useState([]);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState('all');
  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState(null);
  const [openMsgs, setOpenMsgs] = useState({});
  const [composerText, setComposerText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pulsed, setPulsed] = useState(null); // timestamp of last live update
  const [checked, setChecked] = useState(null); // timestamp of the last poll that answered
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState(null);
  const [tray, setTray] = useState('alla');   // manual inbox: which search
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [campaign, setCampaign] = useState('all');   // auto-inbox: which campaign
  const [collapsed, setCollapsed] = useState({});
  const notify = useNotify();
  const { notifyFrom } = notify;

  const load = useCallback(async () => {
    try {
      const rows = await api(`/api/inbox?source=${source}`);
      setThreads(rows);
      notifyFrom(rows);
      setStats(await api('/api/stats'));
    } catch (e) { setError(e.message); }
  }, [source, notifyFrom]);

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

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadThread(activeId); }, [activeId, loadThread]);

  // Poll a tiny change beacon every 3s. Only when it moves do we
  // refetch the list AND the open thread — the open thread used to
  // never refresh, so a reply arriving while you read it stayed
  // invisible until you clicked away and back.
  const version = useRef(null);
  usePoll(async () => {
    const { version: v } = await api('/api/pulse');
    // Stamped on every successful poll, not only on a change: the point
    // of the clock is to show the connection is alive, and a beacon
    // that has not moved is the normal case.
    setChecked(Date.now());
    if (v === version.current) return;
    const first = version.current === null;
    version.current = v;
    await load();
    if (activeId) await loadThread(activeId);
    if (!first) setPulsed(Date.now());
  }, { interval: 3000 });

  // Says what it found, including when that is nothing — "0 nya" is the
  // answer to "is it stuck?", and silence is not.
  async function syncMail() {
    setSyncing(true); setSyncNote(null); setError(null);
    try {
      const r = await api('/api/inbox/sync', { method: 'POST' });
      await load();
      if (activeId) await loadThread(activeId);
      setChecked(Date.now());
      if (r.nya > 0) setPulsed(Date.now());
      setSyncNote(r.nya > 0 ? `${r.nya} nya` : 'inget nytt');
    } catch (e) { setSyncNote(e.message.slice(0, 60)); }
    setSyncing(false);
    setTimeout(() => setSyncNote(null), 6000);
  }

  // ------------------------------------------------------------
  // Filters that answer a question the user actually has.
  //
  // The old four were Alla / Att göra / Väntar svar / Ghostade, and
  // "Att göra" meant "the app drafted a suggestion" — which is about
  // what the APP did, not about what is owed. The honest version of
  // that question is: did they speak last? If the newest message in the
  // thread came from the employer, the ball is with the user, whether
  // or not a draft happens to exist.
  //
  // The rest exist because 250 applications with 91 replies is not a
  // list anyone reads top to bottom. Free text is the one that carries
  // most of the weight — you remember the company, not the position in
  // a list.
  // "Din tur" is a list of conversations that are still alive and
  // waiting on YOU. Two conditions, and both are needed.
  //
  // They spoke last — otherwise the ball is with them. And the thread
  // has somewhere left to go: a rejection whose last word is "tyvärr
  // inte" is not your turn, it is over, and a bounce is not a
  // conversation at all. Before this, every finished rejection sat in
  // the list forever and made the count meaningless — 19 of them were
  // not even rejections but undelivered mail.
  const LEVANDE = new Set(['replied', 'interview']);
  const owed = (t) => t.last_direction === 'inbound' && LEVANDE.has(t.status);
  const dagarSedan = (t) => Math.floor(
    (Date.now() - new Date(t.last_msg_at || t.sent_at)) / 86400000);

  // ------------------------------------------------------------
  // Trays, one per search.
  //
  // The auto-inbox groups by campaign because each campaign is a
  // separate bet. The manual inbox had no such structure — every
  // application you made by hand or through an ad's own link in one
  // flat list, whichever search you found it in.
  //
  // Same idea, laid out like Gmail's tabs rather than as collapsible
  // headings: here the groups are few and you switch between them,
  // rather than scrolling past them. The count on each is the same
  // "your turn" the top-level badge counts, so the trays add up to the
  // number on the Inkorg tab instead of quietly disagreeing with it.
  const trays = (() => {
    const m = new Map();
    for (const t of threads) {
      const key = t.origin_search_id || 'ingen';
      if (!m.has(key)) {
        m.set(key, {
          key,
          namn: t.search_name || 'Utan sökning',
          borttagen: Boolean(t.search_deleted_at),
          threads: [],
        });
      }
      m.get(key).threads.push(t);
    }
    return [...m.values()]
      .map((g) => ({ ...g, dinTur: g.threads.filter((t) => t.last_direction === 'inbound').length }))
      .sort((a, b) => b.dinTur - a.dinTur || b.threads.length - a.threads.length);
  })();

  const q = query.trim().toLowerCase();
  const filtered = threads.filter((t) => {
    if (source !== 'auto' && tray !== 'alla' && (t.origin_search_id || 'ingen') !== tray) return false;
    if (q && !`${t.title} ${t.employer} ${t.last_from_name || ''} ${t.last_from_addr || ''}`
      .toLowerCase().includes(q)) return false;
    if (filter === 'owed') return owed(t);
    if (filter === 'interview') return t.status === 'interview';
    if (filter === 'replied') return t.status === 'replied' || t.status === 'interview';
    if (filter === 'rejected') return t.status === 'rejected';
    if (filter === 'awaiting') return t.status === 'sent';
    if (filter === 'ghosted') return t.status === 'ghosted';
    return true;
  }).sort((a, b) => {
    // Oldest first is not a preference here — it is the order in which
    // threads go cold. An employer who wrote nine days ago is the one
    // about to conclude you are not interested.
    if (sort === 'oldest') return dagarSedan(b) - dagarSedan(a);
    return 0;   // server order: most recent activity first
  });

  const antal = {
    all: threads.length,
    owed: threads.filter(owed).length,
    interview: threads.filter((t) => t.status === 'interview').length,
    replied: threads.filter((t) => t.status === 'replied' || t.status === 'interview').length,
    rejected: threads.filter((t) => t.status === 'rejected').length,
    awaiting: threads.filter((t) => t.status === 'sent').length,
    ghosted: threads.filter((t) => t.status === 'ghosted').length,
  };

  // The auto-inbox is organised by campaign; the manual one stays flat,
  // because a letter you wrote yourself belongs to no campaign.
  const grouped = source === 'auto' ? groupByCampaign(filtered) : [];
  const visible = campaign === 'all'
    ? grouped
    : grouped.filter((g) => String(g.id || 'ingen') === campaign);

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
          <div className="idx">{source === 'auto' ? '04 / Automatiska ansökningar' : '03 / Ansökningar'}</div>
          <h2>
            {source === 'auto' ? 'Auto-inkorg' : 'Inkorg'}
            <LiveDot pulsed={pulsed} checked={checked} />
            {/* The poll keeps the app level with the DATABASE; this
                fetches from Gmail. Different things, and the difference
                only shows up when the worker's IDLE connection goes
                quiet — which it has. */}
            <button className="sync-btn" onClick={syncMail} disabled={syncing}
              title="Hämta ny post från Gmail nu">
              {syncing ? <>Hämtar<Dots label="Hämtar" /></> : '↻ Hämta post'}
            </button>
            {syncNote && <span className="sync-note">{syncNote}</span>}
            <button
              className={`notify-toggle${notify.enabled ? ' on' : ''}`}
              onClick={notify.toggle}
              title={notify.permission === 'denied'
                ? 'Notiser är blockerade i webbläsarens inställningar'
                : notify.enabled ? 'Notiser på — klicka för att stänga av'
                : 'Få en notis när en arbetsgivare svarar'}
              disabled={notify.permission === 'denied'}
            >
              {notify.enabled ? '🔔' : '🔕'}
            </button>
          </h2>
          {source !== 'auto' && trays.length > 1 && (
            <div className="tray-bar" role="tablist">
              <button role="tab" aria-selected={tray === 'alla'} onClick={() => setTray('alla')}>
                Alla
                {trays.reduce((s, g) => s + g.dinTur, 0) > 0 && (
                  <span className="tray-n">{trays.reduce((s, g) => s + g.dinTur, 0)}</span>
                )}
              </button>
              {trays.map((g) => (
                <button key={g.key} role="tab" aria-selected={tray === g.key}
                  onClick={() => setTray(g.key)}
                  title={g.borttagen ? 'Sökningen är borttagen — trådarna finns kvar' : g.namn}>
                  {g.namn}
                  {g.borttagen && <em className="tray-gone">borttagen</em>}
                  {g.dinTur > 0 && <span className="tray-n">{g.dinTur}</span>}
                </button>
              ))}
            </div>
          )}

          <div className="inbox-search">
            <input
              className="ct-input" value={query} placeholder="Sök företag, roll eller person…"
              onChange={(e) => setQuery(e.target.value)}
            />
            <select className="ct-input inbox-sort" value={sort}
              onChange={(e) => setSort(e.target.value)}>
              <option value="recent">Senaste först</option>
              <option value="oldest">Längst utan svar först</option>
            </select>
          </div>
          <div className="inbox-filters">
            {[['all', 'Alla'], ['owed', 'Din tur'], ['interview', 'Intervju'],
              ['replied', 'Svar inne'], ['rejected', 'Avslag'],
              ['awaiting', 'Väntar svar'], ['ghosted', 'Ghostade']]
              .filter(([k]) => k === 'all' || antal[k] > 0)
              .map(([k, label]) => (
                <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {label} <span className="filt-n">{antal[k]}</span>
                </button>
              ))}
          </div>
          {source === 'auto' && grouped.length > 1 && (
            <div className="camp-bar">
              <button aria-pressed={campaign === 'all'} onClick={() => setCampaign('all')}>
                Alla kampanjer
              </button>
              {grouped.map((g) => (
                <button
                  key={g.id || 'ingen'}
                  aria-pressed={campaign === String(g.id || 'ingen')}
                  onClick={() => setCampaign(String(g.id || 'ingen'))}
                  title={g.purpose || ''}
                >
                  {g.name}<span className="camp-count">{g.threads.length}</span>
                </button>
              ))}
            </div>
          )}
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
          {source === 'auto' ? visible.map((g) => {
            const key = String(g.id || 'ingen');
            const shut = !!collapsed[key];
            return (
              <div className="camp-group" key={key}>
                <CampaignHead
                  group={g}
                  collapsed={shut}
                  onToggle={() => setCollapsed((c) => ({ ...c, [key]: !shut }))}
                  onSaved={load}
                />
                {!shut && g.threads.map((t) => (
                  <ThreadItem key={t.id} t={t} active={t.id === activeId}
                    onClick={() => setActiveId(t.id)} />
                ))}
              </div>
            );
          }) : filtered.map((t) => (
            <ThreadItem key={t.id} t={t} active={t.id === activeId}
              onClick={() => setActiveId(t.id)} />
          ))}
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
