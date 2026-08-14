'use client';
import { useEffect, useMemo, useState } from 'react';
import { api, timeAgo } from '../lib/api.js';

function intervalLabel(iv) {
  if (!iv) return '';
  if (typeof iv === 'string') return iv.replace('hours', 'tim').replace('hour', 'tim').replace('days', 'dygn').replace('day', 'dygn').replace('minutes', 'min');
  if (iv.hours) return `${iv.hours} tim`;
  if (iv.days) return `${iv.days} dygn`;
  if (iv.minutes) return `${iv.minutes} min`;
  return '';
}

const SORTS = {
  scanned: {
    label: 'Senast skannad',
    fn: (a, b) => new Date(b.last_scanned_at || 0) - new Date(a.last_scanned_at || 0),
  },
  created: {
    label: 'Nyast först',
    fn: (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
  },
  name: {
    label: 'Namn A–Ö',
    fn: (a, b) => a.name.localeCompare(b.name, 'sv'),
  },
  matches: {
    label: 'Flest matchningar',
    fn: (a, b) => Number(b.match_count) - Number(a.match_count),
  },
  drafts: {
    label: 'Flest utkast',
    fn: (a, b) => Number(b.draft_count) - Number(a.draft_count),
  },
};

export default function Library({ searches, activeSearchId, onPick, onNew, onProfile, onDeleted }) {
  const [profile, setProfile] = useState(null);
  const [sort, setSort] = useState('scanned');
  const [confirming, setConfirming] = useState(null); // id awaiting delete confirmation
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    api('/api/profile').then(setProfile).catch(() => {});
    const saved = window.localStorage.getItem('jobbflo.searchSort');
    if (saved && SORTS[saved]) setSort(saved);
  }, []);

  function changeSort(v) {
    setSort(v);
    window.localStorage.setItem('jobbflo.searchSort', v);
  }

  const sorted = useMemo(
    () => [...searches].sort(SORTS[sort]?.fn || SORTS.scanned.fn),
    [searches, sort]
  );

  async function remove(id) {
    setBusy(id);
    try {
      // soft delete — the inbox back-references searches, so the
      // thread's "hitta liknande jobb" degrades instead of breaking
      await api(`/api/searches/${id}`, { method: 'DELETE' });
      setConfirming(null);
      onDeleted?.(id);
    } catch {
      setConfirming(null);
    }
    setBusy(null);
  }

  const initials = profile?.name
    ?.split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '—';

  return (
    <div className="library">
      <div className="library-header">
        <div className="idx">00 / Sökningar</div>
        <h2>Bibliotek</h2>
        <button className="new-search" onClick={onNew}>+ Ny sökning</button>
        <div className="lib-sort">
          <label htmlFor="libSort">Sortera</label>
          <select id="libSort" value={sort} onChange={(e) => changeSort(e.target.value)}>
            {Object.entries(SORTS).map(([k, s]) => (
              <option key={k} value={k}>{s.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="library-list" role="list">
        {sorted.map((s) => (
          <div className="search-row" role="listitem" key={s.id}>
            <button
              className="search-item"
              aria-current={s.id === activeSearchId}
              onClick={() => onPick(s.id)}
            >
              <span className="name">{s.name}</span>
              {s.email_alias && profile?.email && (
                <span className="alias">{profile.email.replace('@', `+${s.email_alias}@`)}</span>
              )}
              <span className="stats">
                <span className="count">{s.match_count} matchningar</span>
                {Number(s.draft_count) > 0 && <> · <span className="pending">{s.draft_count} utkast</span></>}
                {Number(s.sent_count) > 0 && <> · {s.sent_count} skickade</>}
              </span>
              <span className="when">
                {s.last_scanned_at ? `Skannad ${timeAgo(s.last_scanned_at)}` : 'Ej skannad'}
                {s.scan_enabled && intervalLabel(s.scan_interval) ? ` · var ${intervalLabel(s.scan_interval)}` : ''}
              </span>
            </button>

            <button
              className="search-del"
              title={`Ta bort "${s.name}"`}
              aria-label={`Ta bort sökningen ${s.name}`}
              onClick={() => setConfirming(confirming === s.id ? null : s.id)}
            >
              ✕
            </button>

            {confirming === s.id && (
              <div className="search-confirm">
                <span>Ta bort <b>{s.name}</b>?</span>
                <span className="sc-note">
                  Annonser och skickade ansökningar finns kvar — sökningen döljs bara.
                </span>
                <div className="sc-acts">
                  <button className="btn" onClick={() => setConfirming(null)}>Avbryt</button>
                  <button className="btn primary" disabled={busy === s.id} onClick={() => remove(s.id)}>
                    {busy === s.id ? 'Tar bort…' : 'Ta bort'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {!searches.length && <div className="loading-note">Inga sökningar än</div>}
      </div>

      <button className="profile-link" onClick={onProfile}>
        <span className="avatar">{initials}</span>
        <span>
          <span className="who-name">{profile?.name || 'Profil'}</span>
          <span className="cv-state">{profile?.cv_text ? 'CV inlagt' : 'CV saknas'}</span>
        </span>
      </button>
    </div>
  );
}
