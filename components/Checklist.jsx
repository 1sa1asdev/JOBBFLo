'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ------------------------------------------------------------
// The rows the score was computed from.
//
// The number on the card is arithmetic over these: each requirement the
// ad states, answered against the CV. Shown with both sides' own words
// — the ad's demand and the line in the CV that answers it — so a
// verdict can be checked rather than believed.
//
// Fetched when a card is opened, not with the list: one ad's checklist
// is a dozen rows, and a hundred of them would be a megabyte nobody
// reads.
// ------------------------------------------------------------
const ORDNING = { saknas: 0, delvis: 1, okänt: 2, uppfyllt: 3 };
const ETIKETT = {
  uppfyllt: 'Uppfyllt', delvis: 'Delvis', saknas: 'Saknas', okänt: 'Oklart',
};

export default function Checklist({ adId, searchId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let levande = true;
    api(`/api/ads/${adId}${searchId ? `?search=${searchId}` : ''}`)
      .then((d) => { if (levande) setData(d); })
      .catch((e) => { if (levande) setError(e.message); });
    return () => { levande = false; };
  }, [adId, searchId]);

  if (error) return <div className="chk-wait">kunde inte läsa kraven: {error}</div>;
  if (!data) return <div className="chk-wait">läser kraven…</div>;

  const items = data.check?.items || [];
  if (!items.length) {
    return <div className="chk-wait">Ingen kravlista — bedömd före kravchecken.</div>;
  }

  const sorterade = [...items].sort((a, b) =>
    (ORDNING[a.status] ?? 9) - (ORDNING[b.status] ?? 9)
    || (a.weight === b.weight ? 0 : a.weight === 'meriterande' ? 1 : -1));

  return (
    <div className="chk" onClick={(e) => e.stopPropagation()}>
      {sorterade.map((i, n) => (
        <div key={n} className={`chk-row s-${i.status}`}>
          <span className="chk-status">{ETIKETT[i.status] || i.status}</span>
          <div className="chk-mid">
            <div className="chk-name">
              {i.name}
              {i.weight === 'meriterande' && <em>meriterande</em>}
              {i.dealbreaker && <em className="chk-stop">stoppar</em>}
            </div>
            {i.evidence && <div className="chk-quote">Annonsen: ”{i.evidence}”</div>}
            {i.cv_belagg && <div className="chk-quote cv">CV:t: ”{i.cv_belagg}”</div>}
            {!i.cv_belagg && i.varfor && <div className="chk-why">{i.varfor}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
