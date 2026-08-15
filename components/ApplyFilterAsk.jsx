'use client';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { APPLY_FILTERS } from '../lib/applyFilter.js';

// ------------------------------------------------------------
// The copilot asking how you want to apply, once per search.
//
// The answer is captured by buttons rather than parsed out of free
// text on purpose: this setting decides which ads get spent on, and
// a model misreading "helst mejl" as 'email' when you meant "mejl
// först, men visa allt" would silently hide four fifths of the
// market. The question is conversational; the answer is not.
// ------------------------------------------------------------
export default function ApplyFilterAsk({ search, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function choose(id) {
    setBusy(id); setError(null);
    try {
      await api(`/api/searches/${search.id}`, { method: 'PATCH', body: { apply_filter: id } });
      onChanged?.();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  return (
    <div className="msg ai apply-ask">
      <span className="who">COPILOT</span>
      Hur vill du söka de här jobben? Det avgör vilka annonser jag lägger pengar
      på att bedöma — ungefär var femte annons går att söka via mejl, resten via
      arbetsgivarens eget system.
      <div className="aa-opts">
        {APPLY_FILTERS.map((f) => (
          <button
            key={f.id}
            className="aa-opt"
            disabled={Boolean(busy)}
            onClick={() => choose(f.id)}
          >
            <b>{busy === f.id ? 'Sparar…' : f.label}</b>
            <span>{f.hint}</span>
          </button>
        ))}
      </div>
      {error && <div className="aa-err">{error}</div>}
    </div>
  );
}
