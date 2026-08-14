'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { usePoll } from '../lib/usePoll.js';
import Library from './Library.jsx';
import Chat from './Chat.jsx';
import ResultsList from './ResultsList.jsx';
import LetterView from './LetterView.jsx';
import ProfileView from './ProfileView.jsx';
import Inbox from './Inbox.jsx';

export default function App() {
  const [workspace, setWorkspace] = useState('search'); // search | inbox
  const [view, setView] = useState('list'); // list | letter | profile
  const [searches, setSearches] = useState([]);
  const [activeSearchId, setActiveSearchId] = useState(null);
  const [activeAdId, setActiveAdId] = useState(null);
  const [letterState, setLetterState] = useState(null); // {application, ad, match}
  const [creatingSearch, setCreatingSearch] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [mobilePanel, setMobilePanel] = useState('chat'); // library | chat | stage

  const loadSearches = useCallback(async () => {
    try {
      const rows = await api('/api/searches');
      setSearches(rows);
      setActiveSearchId((cur) => cur || rows[0]?.id || null);
    } catch (e) {
      console.error(e.message);
    }
  }, []);

  const loadInboxCount = useCallback(async () => {
    try {
      const rows = await api('/api/inbox');
      setInboxCount(rows.filter((t) => Number(t.pending_suggestions) > 0).length);
    } catch { /* db not up yet */ }
  }, []);

  useEffect(() => { loadSearches(); loadInboxCount(); }, [loadSearches, loadInboxCount]);

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

  function openAd(adId) {
    setActiveAdId(adId);
    setLetterState(null);
    setView('letter');
    setMobilePanel('stage');
  }

  function backToList() {
    setView('list');
    setActiveAdId(null);
    setLetterState(null);
  }

  function pickSearch(id) {
    setActiveSearchId(id);
    setCreatingSearch(false);
    backToList();
    setMobilePanel('chat');
  }

  function startNewSearch() {
    setCreatingSearch(true);
    setActiveSearchId(null);
    backToList();
    setMobilePanel('chat');
  }

  async function createSearch(criteria) {
    const search = await api('/api/searches', { method: 'POST', body: { criteria } });
    setCreatingSearch(false);
    await loadSearches();
    setActiveSearchId(search.id);
  }

  return (
    <>
      <div className="topnav" role="tablist">
        <span className="brand">Jobbflo</span>
        <button role="tab" aria-selected={workspace === 'search'} onClick={() => setWorkspace('search')}>
          Sökning
        </button>
        <button role="tab" aria-selected={workspace === 'inbox'} onClick={() => setWorkspace('inbox')}>
          Inkorg {inboxCount > 0 && <span className="badge">{inboxCount}</span>}
        </button>
      </div>

      {workspace === 'search' && (
        <div className="mobile-tabs" role="tablist">
          {[['library', 'Sök'], ['chat', 'Chatt'], ['stage', 'Resultat']].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={mobilePanel === k} onClick={() => setMobilePanel(k)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {workspace === 'search' ? (
        <div className="app" data-mobile-panel={mobilePanel}>
          <Library
            searches={searches}
            activeSearchId={activeSearchId}
            onPick={pickSearch}
            onNew={startNewSearch}
            onProfile={() => { setView('profile'); setMobilePanel('stage'); }}
          />
          <Chat
            mode={view === 'letter' ? 'letter' : 'search'}
            search={activeSearch}
            creatingSearch={creatingSearch}
            onCreateSearch={createSearch}
            letterState={letterState}
            onLetterRevised={(app) => setLetterState((s) => (s ? { ...s, application: app } : s))}
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
            {view === 'profile' && <ProfileView onClose={backToList} />}
          </div>
        </div>
      ) : (
        <Inbox
          onFindSimilar={(searchId) => {
            setWorkspace('search');
            if (searchId) pickSearch(searchId);
          }}
        />
      )}
    </>
  );
}
