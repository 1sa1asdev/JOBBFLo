'use client';
import { useEffect, useId, useRef, useState } from 'react';
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

  // /api/locations returns at most 40 municipalities and 30 regions, and
  // filters server-side on ?q. Fetching once without a query therefore
  // only ever offered the alphabetically-first 40 of ~290 kommuner —
  // "Linköping" and everything past it could not be picked at all, and
  // the refusal was silent because an unlisted name is treated as
  // unknown. So the query goes with every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      api(`/api/locations${draft.trim() ? `?q=${encodeURIComponent(draft.trim())}` : ''}`)
        .then(setAll).catch(() => {});
    }, draft ? 160 : 0);
    return () => clearTimeout(t);
  }, [draft]);

  const picked = [].concat(value ?? []).filter(Boolean);
  const known = (s) => all.municipalities.includes(s) || all.regions.includes(s);

  async function commit(next) {
    setSaving(true);
    try { await onSave(next); } finally { setSaving(false); }
  }

  // Validated against the server, not against whatever the suggestion
  // list happens to hold. The list is refetched per keystroke and lands
  // ~160ms later, so committing on local state raced the fetch: pressing
  // Enter right after typing a name checked a list that did not contain
  // it yet and refused silently. Asking the API removes the race and
  // canonicalises the spelling at the same time.
  async function add(name) {
    const n = String(name || '').trim();
    if (!n || picked.includes(n)) return;

    let match = [...all.municipalities, ...all.regions]
      .find((o) => o.toLowerCase() === n.toLowerCase());
    if (!match) {
      try {
        const r = await api(`/api/locations?q=${encodeURIComponent(n)}`);
        match = [...r.municipalities, ...r.regions]
          .find((o) => o.toLowerCase() === n.toLowerCase());
      } catch { /* offline: fall through to the refusal below */ }
    }
    // Refused rather than accepted-and-ignored: an unknown place is not
    // a narrower search, it is one JobSearch matches nothing against,
    // and leaving the text in the box is what makes that visible.
    if (!match || picked.includes(match)) return;

    setDraft('');
    commit([...picked, match]);
  }

  const remove = (name) => commit(picked.filter((p) => p !== name));

  // Only suggest what isn't already chosen, so the list shrinks as you
  // build it rather than offering places you've already added.
  const options = [...all.municipalities, ...all.regions].filter((o) => !picked.includes(o));
  // Unique per instance. Deriving the id from the label gave the wizard
  // and the campaign card the same one, and a duplicate DOM id makes
  // every matching input resolve to whichever datalist came first — so
  // one picker silently drove the other's suggestions.
  const listId = `locs-${useId().replace(/:/g, '')}`;

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
          // Clicking away commits too. Enter alone is one keystroke away
          // from losing what you typed, and a place that silently fails
          // to register is the exact failure this control exists to
          // prevent.
          onBlur={(e) => add(e.currentTarget.value)}
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
