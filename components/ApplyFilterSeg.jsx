'use client';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { APPLY_FILTERS } from '../lib/applyFilter.js';

// ------------------------------------------------------------
// The persistent version of the copilot's question, living above
// the match list — where you are when you decide the mix is wrong.
//
// Changing it does NOT re-score anything. Ads already judged keep
// their scores and stay listed; the filter decides what FUTURE
// scans pay to judge. Narrowing it can therefore leave results on
// screen that the new setting would not have queued, which is
// correct: those calls are already spent, and hiding them would
// waste them twice.
// ------------------------------------------------------------
export default function ApplyFilterSeg({ search, onChanged }) {
  const [busy, setBusy] = useState(false);
  const current = search.apply_filter || 'any';

  async function choose(id) {
    if (busy || id === current) return;
    setBusy(true);
    try {
      await api(`/api/searches/${search.id}`, { method: 'PATCH', body: { apply_filter: id } });
      onChanged?.();
    } catch { /* the list surfaces failures on its next poll */ }
    setBusy(false);
  }

  return (
    <div className="applyseg">
      <span className="as-label">Ansökan via</span>
      <div className="ct-seg" role="group" aria-label="Ansökningssätt att bedöma">
        {APPLY_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            title={f.hint}
            disabled={busy}
            aria-pressed={current === f.id}
            onClick={() => choose(f.id)}
          >
            {f.short}
          </button>
        ))}
      </div>
    </div>
  );
}
