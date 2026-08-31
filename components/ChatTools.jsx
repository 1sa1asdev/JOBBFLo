'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import CvUpload from './CvUpload.jsx';
import LocationPicker from './LocationPicker.jsx';

// ------------------------------------------------------------
// The strip above the criteria chat: location + CV.
//
// Both exist because typing them in prose is tedious and lossy —
// the model turned "hybrid är okej" into remote=true and matched
// zero ads. An explicit picker writes the filter directly, so a
// deliberate choice can't be re-interpreted away.
// ------------------------------------------------------------
export default function ChatTools({ search, onChanged, onCvChanged }) {
  const [saving, setSaving] = useState(false);
  const [cv, setCv] = useState(null);
  const [showCv, setShowCv] = useState(false);

  const loadCv = () => api(`/api/cv${search?.id ? `?search=${search.id}` : ''}`)
    .then((d) => { setCv(d); onCvChanged?.(d); })
    .catch(() => {});

  useEffect(() => { loadCv(); }, [search?.id]);

  // Multi-value now: a search can cover Linköping and Stockholm at
  // once. JobSearch ORs repeated municipality parameters, so this is a
  // widening filter, not a contradictory one.
  async function saveLocations(next) {
    if (!search?.id) return;
    await api(`/api/searches/${search.id}`, { method: 'PATCH', body: { location: next } });
    onChanged?.();
  }

  // Changing this re-runs the free find step, so the list reflects the
  // new filter immediately rather than at the next scheduled scan.
  async function saveWorktime(val) {
    if (!search?.id) return;
    setSaving(true);
    try {
      await api(`/api/searches/${search.id}`, { method: 'PATCH', body: { worktime: val } });
      onChanged?.();
    } catch { /* surfaced by the list on next poll */ }
    setSaving(false);
  }

  if (!search?.id) return null;

  const usingTailored = cv?.active === 'search';
  const noCv = cv?.active === 'none';

  return (
    <div className="chat-tools">
      <div className="ct-row">
        <LocationPicker
          value={search?.location || []}
          onSave={saveLocations}
        />
        {saving && <span className="ct-saving">sparar…</span>}
      </div>

      <div className="ct-row">
        <span className="ct-label">Omfattning</span>
        <div className="ct-seg" role="group" aria-label="Omfattning">
          {[[null, 'Alla'], ['Deltid', 'Deltid'], ['Heltid', 'Heltid']].map(([val, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={(search.api_filters?.['worktime-extent'] || null) === val}
              onClick={() => saveWorktime(val)}
            >
              {label}
            </button>
          ))}
        </div>
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
