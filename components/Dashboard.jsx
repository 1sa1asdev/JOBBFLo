'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate } from '../lib/api.js';
import { usePoll } from '../lib/usePoll.js';
import LiveDot from './LiveDot';
import Dots from './Dots';

// ------------------------------------------------------------
// Did any of this work?
//
// Every other view answers "what is happening now". This one answers
// whether the work paid — and only by SOURCE does that mean anything.
// 238 letters from one campaign at 37% is a different fact from 238
// spread over four searches, and until now the app could not tell them
// apart.
//
// Outcome over activity. Ads found and pages scanned are effort; the
// funnel is here only because it explains a result — "why 238 letters
// from 1214 ads" has an answer, and it is not "the campaign is broken".
//
// Rates below the floor are shown as "—" rather than as numbers. One
// reply out of two is not 50%, and calibration() already refuses to
// pretend otherwise under twenty.
// ------------------------------------------------------------
const n = (v) => Number(v || 0).toLocaleString('sv-SE');

function Stat({ label, value, sub, accent }) {
  return (
    <div className={`dash-stat${accent ? ' accent' : ''}`}>
      <b>{value}</b>
      <span className="dash-stat-label">{label}</span>
      {sub && <span className="dash-stat-sub">{sub}</span>}
    </div>
  );
}

// Letters per day as bars. Plain divs rather than a chart library: the
// shape is the whole message — did the sending run steadily or all in
// one afternoon — and that survives being drawn crudely.
function PerDay({ rows }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.skickade)));
  const senaste = rows.slice(-30);
  return (
    <div className="dash-bars">
      {senaste.map((r) => {
        const höjd = Math.round((Number(r.skickade) / max) * 100);
        const svar = Number(r.skickade)
          ? Math.round((Number(r.svar) / Number(r.skickade)) * 100) : 0;
        return (
          <div className="dash-bar-slot" key={r.dag}
            title={`${fmtDate(r.dag)}: ${r.skickade} skickade, ${r.svar} svar`}>
            <div className="dash-bar" style={{ height: `${höjd}%` }}>
              <div className="dash-bar-reply" style={{ height: `${svar}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [dagar, setDagar] = useState(0);
  const [checked, setChecked] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/dashboard${dagar ? `?dagar=${dagar}` : ''}`));
      setChecked(Date.now());
    } catch (e) { setErr(e.message); }
  }, [dagar]);

  useEffect(() => { load(); }, [load]);
  usePoll(load, { interval: 15000 });

  if (!data) return <div className="loading-note">{err || <>Laddar<Dots /></>}</div>;

  const t = data.total;
  const pct = (v) => (v == null ? '—' : `${v}%`);

  return (
    <div className="dash">
      <div className="auto-head">
        <div className="idx">05 / Översikt</div>
        <h2>Resultat <LiveDot checked={checked} /></h2>
        <p className="auto-lede">
          Vad appen har gjort och vad det gav.{' '}
          {t.forsta && <>Första brevet {fmtDate(t.forsta)}, det senaste {fmtDate(t.senaste)}.</>}{' '}
          Andelar visas först vid {data.minForRate} skickade — under det säger siffran
          mer om slumpen än om kampanjen.
        </p>
      </div>

      <div className="dash-period">
        {[[0, 'Hela tiden'], [30, '30 dagar'], [7, '7 dagar']].map(([d, l]) => (
          <button key={d} className={`cl-pick${dagar === d ? ' active' : ''}`}
            onClick={() => setDagar(d)}>{l}</button>
        ))}
      </div>

      <div className="dash-stats">
        <Stat label="Skickade" value={n(t.skickade)} />
        <Stat label="Svar" value={n(t.svar)} sub={pct(t.replyRate)} accent />
        <Stat label="Intervjuer" value={n(t.intervjuer)} sub={pct(t.interviewRate)} accent />
        <Stat label="Avslag" value={n(t.avslag)} />
        <Stat label="Väntar svar" value={n(t.vantar)} />
        <Stat label="Utkast" value={n(t.utkast)} />
      </div>

      {data.perDay?.length > 1 && (
        <div className="dash-block">
          <span className="auto-queue-title">Brev per dag — senaste 30</span>
          <PerDay rows={data.perDay} />
          <p className="hint">Mörkare del av stapeln är de som svarat.</p>
        </div>
      )}

      <div className="dash-block">
        <span className="auto-queue-title">Per kampanj och sökning</span>
        <table className="dash-table">
          <thead>
            <tr>
              <th>Källa</th><th>Skickade</th><th>Svar</th>
              <th>Andel</th><th>Intervju</th><th>Väntar</th><th>Senast</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((k) => (
              <tr key={`${k.namn}-${k.search_id || 'x'}`}>
                <td>
                  {k.namn}
                  {k.ar_kampanj && <span className="dash-tag">kampanj</span>}
                  {k.borttagen && <span className="dash-tag gone">borttagen</span>}
                  {!k.automatisk && !k.ar_kampanj && <span className="dash-tag hand">för hand</span>}
                </td>
                <td>{n(k.skickade)}</td>
                <td>{n(k.svar)}</td>
                <td className={k.replyRate != null && k.replyRate >= 30 ? 'good' : ''}>
                  {pct(k.replyRate)}
                </td>
                <td>{n(k.intervjuer)}</td>
                <td>{n(k.vantar)}</td>
                <td className="dim">{fmtDate(k.senaste)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.funnel?.length > 0 && (
        <div className="dash-block">
          <span className="auto-queue-title">Var kandidaterna tar vägen</span>
          {data.funnel.map((f) => (
            <div className="dash-funnel" key={f.name}>
              <span className="dash-funnel-name">{f.name}</span>
              <div className="dash-funnel-steps">
                {[['hittade', 'hittade'], ['med_adress', 'med mejladress'],
                  ['bedomda', 'bedömda'], ['ansokta', 'ansökta']].map(([k, l], i) => (
                    <span className="dash-step" key={k}>
                      {i > 0 && <em>→</em>}
                      <b>{n(f[k])}</b> {l}
                    </span>
                  ))}
              </div>
            </div>
          ))}
          <p className="hint">
            Steget som tappar mest är det som är värt att åtgärda — saknas mejladresser
            är det <b>Hitta adresser</b>, inte kampanjens regler.
          </p>
        </div>
      )}

      {data.cost && (
        <p className="hint dash-cost">
          Modellanrop denna månad: <b>${data.cost.usd}</b> över {n(data.cost.anrop)} anrop.
        </p>
      )}
    </div>
  );
}
