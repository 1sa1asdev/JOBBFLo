'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// ------------------------------------------------------------
// The copilot's next question: the search's filters in their two
// states.
//
// ON is what the user's own words set, and each can be switched off.
// OFF is what the app could add, each with the count it would leave —
// "544 → 20" is a decision somebody can make, "Frontend-utvecklare" on
// its own is not. Nothing here is applied without a click, because
// every narrowing is also a set of jobs the user will never see.
//
// The counts are live from the API, so they are re-read whenever the
// filters could have changed: a click here, or a chat turn that
// re-interpreted the criteria.
// ------------------------------------------------------------
export default function FilterSuggest({ search, turn, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  // The one filter just switched off, so a mis-click is one click back.
  // A removed place or occupation is never offered again as a
  // suggestion, so without this it would be gone for good.
  const [undo, setUndo] = useState(null);
  const req = useRef(0);

  const filterKey = JSON.stringify(search.api_filters || {});

  useEffect(() => {
    const n = ++req.current;
    setError(null);
    api(`/api/searches/${search.id}/filters`)
      .then((d) => { if (n === req.current) setData(d); })
      .catch((e) => { if (n === req.current) setError(e.message); });
  }, [search.id, filterKey, turn]);

  useEffect(() => { setUndo(null); setData(null); }, [search.id]);

  async function patch(body, id) {
    setBusy(id); setError(null);
    try {
      await api(`/api/searches/${search.id}/filters`, { method: 'PATCH', body });
      await onChanged?.();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  const remove = (p) => {
    setUndo(p);
    patch({ remove: p.key }, `på:${p.key}`);
  };
  const add = (a) => {
    setUndo(null);
    patch({ add: { key: a.key, value: a.value, ersätter: a.ersätter } }, `av:${a.key}:${a.value}`);
  };

  if (!data) {
    return (
      <div className="msg ai filter-ask">
        <span className="who">COPILOT</span>
        <span className="fa-wait">{error ? `Kunde inte läsa filtren: ${error}` : 'Räknar vad filtren ger…'}</span>
      </div>
    );
  }

  const n = (x) => (x == null ? '?' : x.toLocaleString('sv-SE'));

  return (
    <div className="msg ai filter-ask">
      <span className="who">COPILOT</span>
      <div className="fa-lead">
        Filtren ger just nu <b>{n(data.träffar)} annonser</b> att bedöma.
      </div>

      <div className="fa-label">På</div>
      <div className="fa-chips">
        {data.på.length === 0 && <span className="fa-none">Inga filter — hela marknaden</span>}
        {data.på.map((p) => (
          <span key={p.key} className="fa-chip on">
            <span className="fa-k">{p.namn}</span>
            <span className="fa-v" title={p.varde}>{p.varde}</span>
            <button
              className="fa-x"
              aria-label={`Ta bort filtret ${p.namn}`}
              title="Ta bort filtret"
              disabled={Boolean(busy)}
              onClick={() => remove(p)}
            >{busy === `på:${p.key}` ? '…' : '✕'}</button>
          </span>
        ))}
        {undo && !busy && (
          <button
            className="fa-undo"
            onClick={() => { const u = undo; setUndo(null); patch({ add: { key: u.key, value: u.value } }, 'undo'); }}
          >Ångra ({undo.namn})</button>
        )}
      </div>

      {data.av.length > 0 && (
        <>
          <div className="fa-label">Vill du smalna av?</div>
          <div className="fa-opts">
            {data.av.map((a) => {
              const id = `av:${a.key}:${a.value}`;
              return (
                <button key={id} className="fa-opt" disabled={Boolean(busy)} onClick={() => add(a)}>
                  <span className="fa-opt-head">
                    <b>{busy === id ? 'Lägger till…' : `${a.namn}: ${a.varde}`}</b>
                    <span className="fa-count">{n(data.träffar)} → {n(a.träffar)}</span>
                  </span>
                  <span className="fa-why">
                    {a.varför}
                    {a.ersätter?.length > 0 && ` · ersätter ${a.ersätter.map((k) => data.på.find((p) => p.key === k)?.namn || k).join(', ').toLowerCase()}`}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {error && <div className="fa-err">{error}</div>}
    </div>
  );
}
