'use client';
import { TYPER, TYPNAMN, DIREKT, rensaTyper } from '../lib/arbetsgivartyp.js';

// ------------------------------------------------------------
// Which employers a search or campaign reaches: four switches, all on
// by default. Turning off Bemanning and Rekrytering leaves the
// employers themselves — the point for a campaign that should write to
// the company, not to a middleman.
//
// Controlled: `value` is the stored filter (null = all), `onChange`
// gets the next one (null when all are on again). The last switch on
// cannot be turned off — no types is not a filter, it is no jobs.
// ------------------------------------------------------------
export default function ArbetsgivarFilter({ value, onChange, busy = false, etikett = 'Arbetsgivare' }) {
  const valda = rensaTyper(value) || TYPER;
  const växla = (t) => {
    const nästa = valda.includes(t) ? valda.filter((x) => x !== t) : TYPER.filter((x) => x === t || valda.includes(x));
    if (!nästa.length) return;
    onChange(rensaTyper(nästa));
  };
  const barDirekt = valda.length === DIREKT.length && DIREKT.every((t) => valda.includes(t));

  return (
    <div className="applyseg ag-filter">
      <span className="as-label">{etikett}</span>
      <div className="ct-seg" role="group" aria-label="Arbetsgivartyper att ta med">
        {TYPER.map((t) => (
          <button key={t} type="button" disabled={busy} aria-pressed={valda.includes(t)}
            onClick={() => växla(t)}>
            {TYPNAMN[t]}
          </button>
        ))}
      </div>
      {!barDirekt && (
        <button type="button" className="ag-direkt" disabled={busy} onClick={() => onChange(DIREKT)}>
          Bara direkt hos arbetsgivaren
        </button>
      )}
    </div>
  );
}
