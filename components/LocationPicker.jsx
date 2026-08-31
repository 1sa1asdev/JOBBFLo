'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// ------------------------------------------------------------
// Places a search covers — one or many.
//
// Shared by the search strip and the campaign card, because a campaign
// wanting "Linköping and Stockholm" is the same question as a search
// wanting it, and two implementations would drift apart.
//
// Only names the taxonomy knows are offered. Free text here would
// recreate the zero-hit bug that this control exists to prevent: an
// unrecognised place is not a filter JobSearch narrows on, it is a
// filter JobSearch matches nothing against.
// ------------------------------------------------------------
export default function LocationPicker({ value, onSave, disabled, label = 'Orter' }) {
  const [all, setAll] = useState({ municipalities: [], regions: [] });
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    api('/api/locations').then(setAll).catch(() => {});
  }, []);

  const picked = [].concat(value ?? []).filter(Boolean);
  const known = (s) => all.municipalities.includes(s) || all.regions.includes(s);

  async function commit(next) {
    setSaving(true);
    try { await onSave(next); } finally { setSaving(false); }
  }

  function add(name) {
    const n = String(name || '').trim();
    // Silently ignoring an unknown place would look identical to adding
    // it and getting no ads, so refuse it and keep it in the box where
    // the user can see and fix it.
    if (!n || !known(n) || picked.includes(n)) return;
    setDraft('');
    commit([...picked, n]);
  }

  const remove = (name) => commit(picked.filter((p) => p !== name));

  // Only suggest what isn't already chosen, so the list shrinks as you
  // build it rather than offering places you've already added.
  const options = [...all.municipalities, ...all.regions].filter((o) => !picked.includes(o));
  const listId = `locs-${label.replace(/\s+/g, '')}`;

  return (
    <div className="locpick">
      <div className="locpick-row">
        <span className="ct-label">{label}</span>
        <input
          ref={inputRef}
          className="ct-input"
          list={listId}
          placeholder={picked.length ? 'lägg till en ort…' : 'hela Sverige'}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            // Choosing from the datalist fires change with the whole
            // value and no keystroke, so take it straight away.
            if (known(e.target.value)) add(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(e.currentTarget.value); }
            // Backspace on an empty box removes the last chip — the
            // behaviour every tag input has, and its absence is felt.
            if (e.key === 'Backspace' && !draft && picked.length) remove(picked[picked.length - 1]);
          }}
        />
        <datalist id={listId}>
          {options.map((o) => <option key={o} value={o} />)}
        </datalist>
        {saving && <span className="ct-saving">sparar…</span>}
      </div>

      {picked.length > 0 && (
        <div className="locpick-chips">
          {picked.map((p) => (
            <span className="locchip" key={p}>
              {p}
              <button onClick={() => remove(p)} disabled={disabled}
                title={`Ta bort ${p}`} aria-label={`Ta bort ${p}`}>✕</button>
            </span>
          ))}
          {picked.length > 1 && (
            <span className="locpick-note">annonser från någon av dessa</span>
          )}
        </div>
      )}
    </div>
  );
}
