'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ------------------------------------------------------------
// What the models picked above will cost a month, recomputed as the
// user picks — before anything is saved or spent. The volume is theirs
// to set; tokens per task are Jobbflo's own measured averages, prices
// are OpenRouter's (src/kostnad.js).
// ------------------------------------------------------------
const usd = (v) => (v < 0.01 && v > 0 ? '< $0.01' : `$${v.toFixed(2)}`);
const kronor = (v) => `ca ${Math.round(v * 10.5)} kr`;
// A single ad costs fractions of a cent; two decimals would say nothing.
const styck = (v) => `${v.toFixed(4)}`;

export default function CostEstimate({ provider, fast, bulk, write, onRekommendera }) {
  const [annonser, setAnnonser] = useState(50);
  const [brev, setBrev] = useState(5);
  const [k, setK] = useState(null);
  const [fel, setFel] = useState(null);

  useEffect(() => {
    if (!provider) return undefined;
    const t = setTimeout(() => {
      api('/api/settings/llm/kostnad', {
        method: 'POST',
        body: { provider, fast, bulk, write, annonserPerVecka: annonser, brevPerVecka: brev },
      }).then((d) => { setK(d); setFel(null); }).catch((e) => setFel(e.message));
    }, 350);
    return () => clearTimeout(t);
  }, [provider, fast, bulk, write, annonser, brev]);

  if (!provider) return null;
  const rek = k?.rekommenderade;
  const ärRek = rek && rek.fast === fast && rek.bulk === bulk && rek.write === write;

  return (
    <div className="cvprofile" style={{ marginTop: 14 }}>
      <div className="cvp-head">
        <div>
          <h3>Vad det kostar dig</h3>
          <p className="cvp-sub">
            Räknat på din volym och vad uppgifterna faktiskt har kostat i Jobbflo. Det dras från
            din egen nyckel, och du sätter en månadsbudget under Profil.
          </p>
        </div>
        {rek && !ärRek && (
          <button className="btn" type="button" onClick={() => onRekommendera?.(rek)}>
            Använd rekommenderade
          </button>
        )}
      </div>

      <div className="two-col">
        <label>
          <span>Annonser du låter bedöma per vecka</span>
          <input className="txt-input" type="number" min="0" max="5000" value={annonser}
            onChange={(e) => setAnnonser(Number(e.target.value))} />
        </label>
        <label>
          <span>Brev du skickar per vecka</span>
          <input className="txt-input" type="number" min="0" max="500" value={brev}
            onChange={(e) => setBrev(Number(e.target.value))} />
        </label>
      </div>

      {fel && <div className="err-note">{fel}</div>}
      {k && (
        <>
          <table className="dash-table">
            <tbody>
              {k.rader.map((r) => (
                <tr key={r.vad}>
                  <td>{r.vad}</td>
                  <td className="dim">
                    {r.modell || '—'}
                    {r.modell && k.testade[r.modell] ? <span className="dash-tag">testad</span> : null}
                    {r.not && <div style={{ fontSize: 11 }}>{r.not}</div>}
                  </td>
                  <td>{usd(r.usd)}</td>
                </tr>
              ))}
              <tr>
                <td><b>Per månad</b></td>
                <td className="dim">{styck(k.perAnnons)} per annons · {styck(k.perBrev)} per brev</td>
                <td><b>{usd(k.månad)}</b> <span className="dim">({kronor(k.månad)})</span></td>
              </tr>
            </tbody>
          </table>
          {ärRek && <p className="hint">Det här är modellerna Jobbflo körs och mäts med.</p>}
          {k.resonerande.length > 0 && (
            <p className="hint">
              {k.resonerande.join(', ')} tänker innan den svarar och kan därför kosta mer än
              uppskattningen.
            </p>
          )}
          {k.okändaPriser.length > 0 && (
            <p className="hint">Inget pris hittades för {k.okändaPriser.join(', ')}. Den raden räknas som 0.</p>
          )}
          {k.prislistaSaknas && <p className="hint">OpenRouters prislista gick inte att hämta just nu.</p>}
        </>
      )}
    </div>
  );
}
