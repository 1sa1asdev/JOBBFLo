'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import CvUpload from './CvUpload.jsx';

// ------------------------------------------------------------
// The strip above the criteria chat: location + CV.
//
// Both exist because typing them in prose is tedious and lossy —
// the model turned "hybrid är okej" into remote=true and matched
// zero ads. An explicit picker writes the filter directly, so a
// deliberate choice can't be re-interpreted away.
// ------------------------------------------------------------
export default function ChatTools({ search, onChanged, onCvChanged }) {
  const [locations, setLocations] = useState({ municipalities: [], regions: [] });
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [cv, setCv] = useState(null);
  const [showCv, setShowCv] = useState(false);

  useEffect(() => {
    api('/api/locations').then(setLocations).catch(() => {});
  }, []);

  useEffect(() => {
    setValue(search?.location || search?.api_filters?.municipality || '');
  }, [search?.id, search?.location]);

  const loadCv = () => api(`/api/cv${search?.id ? `?search=${search.id}` : ''}`)
    .then((d) => { setCv(d); onCvChanged?.(d); })
    .catch(() => {});

  useEffect(() => { loadCv(); }, [search?.id]);

  const savedLocation = () => search?.location || search?.api_filters?.municipality || '';

  async function saveLocation(next) {
    if (!search?.id) return;
    setValue(next);
    setSaving(true);
    try {
      await api(`/api/searches/${search.id}`, { method: 'PATCH', body: { location: next || null } });
      onChanged?.();
    } catch { /* surfaced by the list on next poll */ }
    setSaving(false);
  }

  // Commit directly rather than going through blur(): pressing Enter
  // inside a datalist input doesn't reliably blur it, which silently
  // dropped the change.
  function commit(next) {
    if (String(next).trim() !== savedLocation()) saveLocation(String(next).trim());
  }

  // Auto-save shortly after typing stops. Depending on blur or Enter
  // alone loses edits when neither fires the way you expect, and a
  // filter that silently doesn't apply is the failure mode this whole
  // control exists to prevent.
  useEffect(() => {
    if (!search?.id) return undefined;
    if (value.trim() === savedLocation()) return undefined;
    const t = setTimeout(() => commit(value), 700);
    return () => clearTimeout(t);
  }, [value, search?.id, search?.location]);

  if (!search?.id) return null;

  const usingTailored = cv?.active === 'search';
  const noCv = cv?.active === 'none';

  return (
    <div className="chat-tools">
      <div className="ct-row">
        <label className="ct-label" htmlFor="ct-loc">Ort</label>
        <input
          id="ct-loc"
          className="ct-input"
          list="ct-locations"
          placeholder="hela Sverige"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            // picking from the datalist fires change with the full value
            // and no keystroke, so commit those immediately
            if (locations.municipalities.includes(e.target.value)
              || locations.regions.includes(e.target.value)) commit(e.target.value);
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); } }}
        />
        <datalist id="ct-locations">
          {locations.municipalities.map((m) => <option key={m} value={m} />)}
          {locations.regions.map((r) => <option key={r} value={r} />)}
        </datalist>
        {value && (
          <button className="ct-clear" title="Rensa ort" onClick={() => saveLocation('')}>✕</button>
        )}
        {saving && <span className="ct-saving">sparar…</span>}
      </div>

      <div className="ct-row">
        <span className="ct-label">CV</span>
        <button
          className={`ct-cv${noCv ? ' missing' : ''}${usingTailored ? ' tailored' : ''}`}
          onClick={() => setShowCv(!showCv)}
        >
          {noCv ? 'Inget CV — ladda upp' : usingTailored ? `Anpassat: ${cv.search.filename}` : `Bas-CV: ${cv?.profile?.filename || 'inlagt'}`}
          <i>{showCv ? '▴' : '▾'}</i>
        </button>
      </div>

      {(showCv || noCv) && (
        <div className="ct-cvpanel">
          <p className="ct-cvhint">
            {noCv
              ? 'Ladda upp ditt CV för att kunna bedöma annonser och skriva brev.'
              : 'Ladda upp ett CV som bara gäller den här sökningen — annars används bas-CV:t från Profil.'}
          </p>
          <CvUpload
            compact
            scope={noCv ? 'profile' : 'search'}
            searchId={search.id}
            current={usingTailored ? cv.search : null}
            onDone={() => { loadCv(); onChanged?.(); }}
          />
        </div>
      )}
    </div>
  );
}
