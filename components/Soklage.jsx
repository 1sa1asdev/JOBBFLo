'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { JOBB, REKRYTERING, PROGNOS, ÄNDRING } from '../lib/yrkesord.js';

// ------------------------------------------------------------
// The search chat's market card: how the job market looks for the
// occupations this search actually finds, in its county
// (src/yrkesbarometer.js sökläge). Arbetsförmedlingen's assessment,
// shown as data — no model writes it, so it costs nothing and cannot
// make a forecast up. Fetched again whenever the criteria or the
// conversation move on.
// ------------------------------------------------------------
const tal = (n) => n.toLocaleString('sv-SE');

export default function Sokläge({ search, turn }) {
  const [läge, setLäge] = useState(null);

  useEffect(() => {
    if (!search?.id) return undefined;
    let aktuell = true;
    api(`/api/searches/${search.id}/marknad`)
      .then((d) => { if (aktuell) setLäge(d.läge); })
      .catch(() => { if (aktuell) setLäge(null); });
    return () => { aktuell = false; };
  }, [search?.id, search?.criteria_changed_at, search?.last_scanned_at, turn]);

  if (!läge?.yrken?.length) return null;
  const [först, ...övriga] = läge.yrken;
  const var_ = läge.region ? `i ${läge.region}` : 'i hela Sverige';

  return (
    <div className="msg ai sl-kort" aria-label="Läget för din sökning">
      <span className="who">MARKNADEN</span>
      <div className="sl-rubrik">Läget för din sökning</div>
      <p className="sl-huvud">
        <b>{först.yrke}</b> {var_}: {JOBB[först.jobbmojligheter].toLowerCase()} till arbete
        {först.rekrytering ? `, ${REKRYTERING[först.rekrytering]}` : ''}.
        {först.prognos ? ` På fem års sikt: ${PROGNOS[först.prognos]}.` : ''}
        {först.andring && <span className={`mk-andring ${först.andring}`}> {ÄNDRING[först.andring]}</span>}
      </p>
      <p className="sl-tal">
        {tal(först.oppna)} öppna annonser {var_} · {tal(först.nya_7)} nya senaste veckan
      </p>
      {övriga.map((y) => (
        <p key={y.yb_id} className="sl-ovrig">
          {y.yrke}: {JOBB[y.jobbmojligheter].toLowerCase()} · {tal(y.oppna)} annonser
          {y.andring ? ` (${y.andring === 'bättre' ? '↑' : '↓'})` : ''}
        </p>
      ))}
      <p className="sl-kalla">Bedömning: Arbetsförmedlingens yrkesbarometer {läge.omgang}</p>
    </div>
  );
}
