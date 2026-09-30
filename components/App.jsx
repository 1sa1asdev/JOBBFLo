'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { usePoll } from '../lib/usePoll.js';
import { useUrlState } from '../lib/useUrlState.js';
import Dashboard from './Dashboard';
import { useRowAlign } from '../lib/useRowAlign.js';
import Library from './Library.jsx';
import Chat from './Chat.jsx';
import ResultsList from './ResultsList.jsx';
import LetterView from './LetterView.jsx';
import ProfileView from './ProfileView.jsx';
import Inbox from './Inbox.jsx';
import AutoApply from './AutoApply.jsx';

export default function App() {
  // Where you are lives in the address bar (lib/useUrlState.js), so
  // back, reload and a pasted link all work. Everything below is read
  // from it rather than kept a second time in React state.
  const { urlState, navigate } = useUrlState();
  const workspace = urlState.vy || 'dash';        // dash | search | inbox | auto
  const view = urlState.annons ? 'letter' : 'list';
  const setWorkspace = (v) => navigate({ vy: v === 'dash' ? null : v, annons: null });
  const [searches, setSearches] = useState([]);
  const activeSearchId = urlState.sok || null;
  const activeAdId = urlState.annons || null;
  const [letterState, setLetterState] = useState(null); // {application, ad, match}
  const [creatingSearch, setCreatingSearch] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [autoCount, setAutoCount] = useState(0);
  const [mobilePanel, setMobilePanel] = useState('chat'); // library | chat | stage
  // profile is reachable from EVERY workspace, so it lives outside
  // the search view's `view` state rather than inside it
  const showProfile = urlState.profil === '1';
  const setShowProfile = (v) => navigate({
    profil: (typeof v === 'function' ? v(showProfile) : v) ? '1' : null,
  });
  const [profile, setProfile] = useState(null);

  const loadSearches = useCallback(async () => {
    try {
      const rows = await api('/api/searches');
      setSearches(rows);
      // replace, not push: nobody should have to press back through the
      // app picking a search for them on first load.
      if (!urlStateRef.current.sok && rows[0]?.id) {
        navigateRef.current({ sok: rows[0].id }, { replace: true });
      }
    } catch (e) {
      console.error(e.message);
    }
  }, []);

  // Two inboxes, two counts. Fetching without ?source counted every
  // thread — so campaign replies, which live under Auto-ansökan, were
  // added to the Inkorg badge. Clicking it then showed fewer threads
  // than the number promised, with no way to tell where the rest were.
  const loadInboxCount = useCallback(async () => {
    // Whose turn it is, not what the app drafted. A badge counting
    // suggestions was counting the app's own output — it could sit at 3
    // with nothing owed, or at 0 with an employer waiting a week. The
    // trays inside the inbox count the same thing, so the parts add up
    // to the number on the tab.
    // The same rule the inbox's "Din tur" uses, and it has to stay the
    // same: a badge saying 171 over a list showing 44 teaches the user
    // to stop believing the badge. A finished rejection is not owed,
    // and a bounce is not a conversation.
    const LEVANDE = new Set(['replied', 'interview']);
    const pending = (rows) => rows.filter(
      (t) => t.last_direction === 'inbound' && LEVANDE.has(t.status)).length;
    try {
      const [mine, auto] = await Promise.all([
        api('/api/inbox?source=user'),
        api('/api/inbox?source=auto'),
      ]);
      setInboxCount(pending(mine));
      setAutoCount(pending(auto));
    } catch { /* db not up yet */ }
  }, []);

  useEffect(() => { loadSearches(); loadInboxCount(); }, [loadSearches, loadInboxCount]);
  useEffect(() => { api('/api/profile').then(setProfile).catch(() => {}); }, [showProfile]);

  // sidebar counts + inbox badge follow the same beacon, so the
  // badge appears as soon as a reply is classified
  const version = useRef(null);
  usePoll(async () => {
    const { version: v } = await api('/api/pulse');
    if (v === version.current) return;
    version.current = v;
    await Promise.all([loadSearches(), loadInboxCount()]);
  }, { interval: 5000 });

  const activeSearch = searches.find((s) => s.id === activeSearchId) || null;

  // The URL can change under us — back, forward, a pasted link — and a
  // letter on screen belongs to the ad it was built for. Dropped as
  // soon as that is no longer the ad in the URL.
  const letterAdId = useRef(null);
  useEffect(() => {
    if (letterAdId.current !== activeAdId) {
      letterAdId.current = activeAdId;
      setLetterState(null);
    }
  }, [activeAdId]);

  // Read inside loadSearches without making that callback depend on
  // every navigation.
  const urlStateRef = useRef(urlState);
  const navigateRef = useRef(navigate);
  useEffect(() => { urlStateRef.current = urlState; navigateRef.current = navigate; }, [urlState, navigate]);

  // keep the rules continuous across the pane dividers as the view,
  // the selected search or the window size changes
  useRowAlign([workspace, view, activeSearchId, searches.length]);

  function openAd(adId) {
    setLetterState(null);
    navigate({ vy: 'search', annons: adId });
    setMobilePanel('stage');
  }

  // The same step the browser's own back button now takes, so the two
  // agree instead of competing.
  function backToList() {
    setLetterState(null);
    navigate({ annons: null });
  }

  function pickSearch(id) {
    setCreatingSearch(false);
    setLetterState(null);
    navigate({ vy: 'search', sok: id, annons: null });
    setMobilePanel('chat');
  }

  function startNewSearch() {
    setCreatingSearch(true);
    setActiveSearchId(null);
    backToList();
    setMobilePanel('chat');
  }

  // deleting the search you're looking at must not leave the stage
  // pointing at something that no longer exists
  async function handleSearchDeleted(id) {
    const rows = await api('/api/searches').catch(() => []);
    setSearches(rows);
    if (id === activeSearchId) {
      backToList();
      setActiveSearchId(rows[0]?.id || null);
    }
  }

  async function createSearch(criteria, applyFilter) {
    const search = await api('/api/searches', {
      method: 'POST',
      body: { criteria, apply_filter: applyFilter || null },
    });
    setCreatingSearch(false);
    await loadSearches();
    setActiveSearchId(search.id);
  }

  return (
    <>
      <div className="topnav" role="tablist">
        {/* The brand is the way home from anywhere, which is what a
            brand in the top-left is for. */}
        <button className="brand" onClick={() => setWorkspace('dash')}
          title="Till översikten">Jobbflo</button>
        <button role="tab" aria-selected={workspace === 'dash'} onClick={() => setWorkspace('dash')}>
          Översikt
        </button>
        <button role="tab" aria-selected={workspace === 'search'} onClick={() => setWorkspace('search')}>
          Sökning
        </button>
        <button role="tab" aria-selected={workspace === 'inbox'} onClick={() => setWorkspace('inbox')}>
          Inkorg {inboxCount > 0 && <span className="badge">{inboxCount}</span>}
        </button>
        <button role="tab" aria-selected={workspace === 'auto'} onClick={() => setWorkspace('auto')}>
          Auto-ansökan {autoCount > 0 && <span className="badge">{autoCount}</span>}
        </button>
        <button
          className={`topnav-profile${showProfile ? ' active' : ''}`}
          aria-pressed={showProfile}
          title="Profil, CV och AI-leverantör"
          onClick={() => setShowProfile(!showProfile)}
        >
          <span className="tp-avatar">
            {(profile?.name || '—').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
          </span>
          <span className="tp-label">Profil</span>
        </button>
      </div>

      {workspace === 'search' && !showProfile && (
        <div className="mobile-tabs" role="tablist">
          {[['library', 'Sök'], ['chat', 'Chatt'], ['stage', 'Resultat']].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={mobilePanel === k} onClick={() => setMobilePanel(k)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {showProfile ? (
        <div className="profile-shell">
          <ProfileView onClose={() => setShowProfile(false)} />
        </div>
      ) : workspace === 'search' ? (
        <div className="app" data-mobile-panel={mobilePanel}>
          <Library
            searches={searches}
            activeSearchId={activeSearchId}
            onPick={pickSearch}
            onNew={startNewSearch}
            onProfile={() => setShowProfile(true)}
            onDeleted={handleSearchDeleted}
          />
          <Chat
            mode={view === 'letter' ? 'letter' : 'search'}
            search={activeSearch}
            creatingSearch={creatingSearch}
            onCreateSearch={createSearch}
            letterState={letterState}
            onLetterRevised={(app) => setLetterState((s) => (s ? { ...s, application: app } : s))}
            onSearchChanged={loadSearches}
          />
          <div className="stage">
            {view === 'list' && (
              <ResultsList
                search={activeSearch}
                creatingSearch={creatingSearch}
                onOpenAd={openAd}
                onSearchChanged={loadSearches}
              />
            )}
            {view === 'letter' && activeAdId && (
              <LetterView
                adId={activeAdId}
                search={activeSearch}
                letterState={letterState}
                setLetterState={setLetterState}
                onBack={backToList}
              />
            )}
          </div>
        </div>
      ) : workspace === 'dash' ? (
        <Dashboard />
      ) : workspace === 'auto' ? (
        <AutoApply
          onFindSimilar={(searchId) => {
            setWorkspace('search');
            if (searchId) pickSearch(searchId);
          }}
        />
      ) : (
        <Inbox
          source="user"
          onFindSimilar={(searchId) => {
            setWorkspace('search');
            if (searchId) pickSearch(searchId);
          }}
        />
      )}
    </>
  );
}
