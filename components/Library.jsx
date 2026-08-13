'use client';
import { useEffect, useState } from 'react';
import { api, timeAgo } from '../lib/api.js';

function intervalLabel(iv) {
  if (!iv) return '';
  if (typeof iv === 'string') return iv.replace('hours', 'tim').replace('hour', 'tim').replace('days', 'dygn').replace('day', 'dygn').replace('minutes', 'min');
  if (iv.hours) return `${iv.hours} tim`;
  if (iv.days) return `${iv.days} dygn`;
  if (iv.minutes) return `${iv.minutes} min`;
  return '';
}

export default function Library({ searches, activeSearchId, onPick, onNew, onProfile }) {
  const [profile, setProfile] = useState(null);
  useEffect(() => {
    api('/api/profile').then(setProfile).catch(() => {});
  }, []);

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
      </div>
      <div className="library-list" role="list">
        {searches.map((s) => (
          <button
            key={s.id}
            className="search-item"
            role="listitem"
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
