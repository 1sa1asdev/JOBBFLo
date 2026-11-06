'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Dots from './Dots';

// ------------------------------------------------------------
// Marknaden: the shared market, the same for every user (src/marknad.js).
// Platsbanken's ads by occupation field — who is hiring, how many
// openings, how fast ads close — and, where enough users stand behind
// it, how many applied through the app and how often employers answer.
// ------------------------------------------------------------
const tal = (n) => (n == null ? '—' : n.toLocaleString('sv-SE'));

function Trend({ v }) {
  if (v == null) return null;
  const upp = v > 0;
  return (
    <span className={`mk-trend ${v === 0 ? '' : upp ? 'upp' : 'ned'}`}
      title="Nya annonser de senaste 14 dagarna mot de 14 före">
      {v === 0 ? '±0 %' : `${upp ? '▲' : '▼'} ${Math.abs(v)} %`}
    </span>
  );
}

export default function Marknaden() {
  const [region, setRegion] = useState('');
  const [data, setData] = useState(null);
  const [fel, setFel] = useState(null);

  useEffect(() => {
    let aktuell = true;
    setFel(null);
    api(`/api/marknad${region ? `?region=${encodeURIComponent(region)}` : ''}`)
      .then((d) => { if (aktuell) setData(d); })
      .catch((e) => { if (aktuell) setFel(e.message); });
    return () => { aktuell = false; };
  }, [region]);

  if (!data) return <div className="loading-note">{fel || <>Laddar marknaden<Dots /></>}</div>;
  const regioner = [...data.regioner].sort((a, b) => a.region.localeCompare(b.region, 'sv'));
  const kvarTillTrend = Math.max(0, data.historik.trendFrån - data.historik.dagar);

  return (
    <div className="dash">
      <div className="auto-head">
        <div className="idx">05 / Marknaden</div>
        <h2>Vem anställer just nu</h2>
        <p className="auto-lede">
          Alla Platsbankens annonser, sorterade efter yrkesområde. Samma siffror för alla som
          använder Jobbflo — inget här handlar om dig.
        </p>
      </div>

      <div className="mk-filter">
        <label htmlFor="mk-region" className="mk-etikett">Region</label>
        <select id="mk-region" className="ct-input" value={region} onChange={(e) => { setData(null); setRegion(e.target.value); }}>
          <option value="">Hela Sverige</option>
          {regioner.map((r) => <option key={r.region_id} value={r.region_id}>{r.region}</option>)}
        </select>
      </div>
      {fel && <div className="err-note" role="alert">{fel}</div>}

      <div className="dash-stats">
        <div className="dash-stat"><b>{tal(data.totalt.oppna)}</b><span className="dash-stat-label">Öppna annonser</span></div>
        <div className="dash-stat"><b>{tal(data.totalt.platser)}</b><span className="dash-stat-label">Platser i dem</span></div>
        <div className="dash-stat accent"><b>{tal(data.totalt.nya_7)}</b><span className="dash-stat-label">Nya senaste 7 dagarna</span></div>
      </div>

      <div className="dash-block">
        <span className="auto-queue-title">Per yrkesområde</span>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Marknaden per yrkesområde">
          <table className="dash-table adm-stack mk-tabell">
            <thead>
              <tr>
                <th>Yrkesområde</th><th>Öppna</th><th>Nya 7 d</th><th>Platser</th>
                <th>Dagar öppen</th><th>Sökt via Jobbflo</th><th>Svar</th>
              </tr>
            </thead>
            <tbody>
              {data.rader.map((r) => (
                <tr key={r.falt_id}>
                  <td className="adm-konto" data-label="Yrkesområde">{r.falt}</td>
                  <td data-label="Öppna annonser">{tal(r.oppna)}</td>
                  <td data-label="Nya senaste 7 dagarna">{tal(r.nya_7)} <Trend v={r.trend} /></td>
                  <td data-label="Platser">{tal(r.platser)}</td>
                  <td data-label="Dagar tills annonsen togs ned">{r.median_dagar == null ? '—' : `${r.median_dagar} d`}</td>
                  <td data-label="Sökt via Jobbflo, 30 dagar">{tal(r.sokta_30)}</td>
                  <td data-label="Svar från arbetsgivare">
                    {r.svar ? (
                      <span className="mk-svar">
                        <b>{r.svar.andel} % svarade</b>
                        <span className="mk-av">{r.svar.intervju} % intervju · {r.svar.nej} % nej · av {r.svar.av}</span>
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mk-forklaring">
        <p><b>Platser</b> — en annons kan söka flera personer; räknas från och med nu, äldre annonser räknas som en.</p>
        <p><b>Dagar öppen</b> — mediantiden från publicering tills annonser togs ned den senaste veckan. Det närmaste
          man kommer hur snabbt tjänster tillsätts. Visas när minst {data.gränser.användare} annonser stängts.</p>
        <p><b>Sökt via Jobbflo</b> och <b>Svar</b> bygger på vad användarna gjort, och visas först när minst
          {' '}{data.gränser.användare} olika användare står bakom en siffra — och för svar minst {data.gränser.svar} skickade
          ansökningar — så att ingen enskild kan pekas ut.</p>
        <p><b>Svar</b> — andelen ansökningar som arbetsgivaren svarade på alls, och hur många av dem som blev
          intervju eller nej. Räknar brev skickade via Jobbflo de senaste 90 dagarna som kommit fram och fått
          minst {data.gränser.svarstid} dagar på sig. Studsade och återkallade ansökningar räknas inte, och
          inte heller de du sökt på arbetsgivarens egen sida — svaren på dem syns inte i appen.</p>
        <p><b>Trend</b> — {kvarTillTrend > 0
          ? `visas när 4 veckors historik samlats, om ${kvarTillTrend} dagar.`
          : 'nya annonser de senaste 14 dagarna mot de 14 före.'}</p>
        <p className="mk-kalla">Källa: Platsbanken via Arbetsförmedlingens JobStream. Uppdateras löpande; historiken sparas dagligen.</p>
      </div>
    </div>
  );
}
