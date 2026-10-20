'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate } from '../lib/api.js';
import Dots from './Dots';

// ------------------------------------------------------------
// The operator's page: the platform's own key and spend, the pool and
// the worker, and the users — what they cost and do, never what they
// write. Reached only by an admin account (users.role); for anyone else
// the page and its API answer 404.
// ------------------------------------------------------------

const kr = (usd) => (usd == null ? '—' : `$${Number(usd).toFixed(2)}`);
const ålder = (sek) => {
  if (sek == null) return 'aldrig';
  if (sek < 90) return `${sek} s sedan`;
  if (sek < 5400) return `${Math.round(sek / 60)} min sedan`;
  if (sek < 172800) return `${Math.round(sek / 3600)} h sedan`;
  return `${Math.round(sek / 86400)} dygn sedan`;
};

function Stat({ label, value, sub, accent }) {
  return (
    <div className={`dash-stat${accent ? ' accent' : ''}`}>
      <span className="dash-stat-label">{label}</span>
      <b>{value}</b>
      {sub && <span className="dash-stat-sub">{sub}</span>}
    </div>
  );
}

export default function AdminView() {
  const [ö, setÖ] = useState(null);
  const [users, setUsers] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const ladda = () => Promise.all([
    api('/api/admin/oversikt').then(setÖ),
    api('/api/admin/anvandare').then((d) => setUsers(d.användare)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { ladda(); }, []);

  async function embeddings(på) {
    setBusy('embed'); setError(null);
    try { setÖ(await api('/api/admin/installningar', { method: 'PATCH', body: { embeddings: på } })); }
    catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function spärr(u, spärrad) {
    if (spärrad && !window.confirm(`Spärra ${u.email}? Inloggningen nekas, kampanjerna pausas och brevlådan stängs.`)) return;
    setBusy(u.id); setError(null);
    try {
      await api(`/api/admin/anvandare/${u.id}`, { method: 'PATCH', body: { spärrad } });
      await ladda();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  if (!ö || !users) return <div className="loading-note">{error || <>Laddar<Dots /></>}</div>;
  const e = ö.embeddings;
  const w = ö.worker;
  const workerDöd = w.sekunderSedan == null || w.sekunderSedan > 120;

  return (
    <div className="dash">
      <a className="llm-link" href="/">← Till appen</a>
      <div className="idx" style={{ marginTop: 14 }}>Admin</div>
      <h2>Plattformen</h2>
      {error && <div className="err-note">{error}</div>}

      <div className="dash-stats">
        <Stat label="Plattformsnyckel" value={ö.plattformsnyckel.satt ? 'satt' : 'saknas'} accent={!ö.plattformsnyckel.satt}
          sub={ö.plattformsnyckel.kredit ? `${kr(ö.plattformsnyckel.kredit.left)} kvar av ${kr(ö.plattformsnyckel.kredit.bought)}` : 'ingen kreditinfo'} />
        <Stat label="Öppna annonser" value={ö.pool.öppna.toLocaleString('sv-SE')} sub={`+${ö.pool.nyaDygnet} senaste dygnet`} />
        <Stat label="Indexerade" value={`${e.pct}%`} sub={`${e.embedded.toLocaleString('sv-SE')} av ${e.total.toLocaleString('sv-SE')}`} />
        <Stat label="Workern" value={workerDöd ? 'tyst' : 'lever'} accent={workerDöd} sub={ålder(w.sekunderSedan)} />
        <Stat label="Användare" value={ö.användare.totalt} sub={`${ö.användare.nya_veckan} nya i veckan · ${ö.användare.spärrade} spärrade`} />
        <Stat label="Användarnas AI, 30 d" value={kr(ö.användarnasKostnad30d.usd)} sub="på deras egna nycklar" />
      </div>

      <section className="dash-block">
        <div className="dash-stat-label">Vektorindex för annonspoolen — plattformens kostnad</div>
        <p className="hint">
          {e.påslagna
            ? <>På. Nya annonser indexeras i bakgrunden med <b>{e.modell}</b> ({e.leverantör}). Det som
                återstår kostar ungefär <b>{kr(e.kvarUsd)}</b>; hela poolen från början skulle kosta
                {' '}{kr(e.helaPoolenUsd)}.</>
            : <>Av. Inga nya annonser indexeras och inget kostar. Redan indexerade annonser behålls,
                så att slå på igen kostar bara det som tillkommit ({kr(e.kvarUsd)} i dag).</>}
          {' '}Modellen byts i serverns inställningar (EMBED_MODEL), eftersom ett byte kräver att hela
          poolen indexeras om.
        </p>
        <button className="btn" type="button" disabled={busy === 'embed'} onClick={() => embeddings(!e.påslagna)}>
          {busy === 'embed' ? 'Sparar…' : e.påslagna ? 'Stäng av indexeringen' : 'Slå på indexeringen'}
        </button>
      </section>

      <section className="dash-block">
        <div className="dash-stat-label">Bakgrundsjobb</div>
        <table className="dash-table">
          <tbody>
            <tr><td>JobStream (nya annonser)</td><td>{ålder(w.jobstream.sekunderSedan)}</td><td className="dim" /></tr>
            <tr><td>Daglig ögonblicksbild</td><td>{w.ögonblicksbild.senast ? fmtDate(w.ögonblicksbild.senast) : 'aldrig'}</td>
              <td className="dim">{w.ögonblicksbild.not}</td></tr>
            <tr><td>Städning</td><td>{w.städning.senast ? fmtDate(w.städning.senast) : 'aldrig'}</td>
              <td className="dim">{w.städning.not}</td></tr>
            {w.ögonblicksbildFel && (
              <tr><td>Senaste fel i ögonblicksbilden</td><td>{fmtDate(w.ögonblicksbildFel.senast)}</td>
                <td className="dim">{w.ögonblicksbildFel.not}</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="dash-block">
        <div className="dash-stat-label">Fel som ingen fångade, senaste 7 dygnen</div>
        {ö.fel.length === 0 ? <p className="hint">Inga.</p> : (
          <table className="dash-table">
            <thead><tr><th>Var</th><th>Fel</th><th>Antal</th><th>Senast</th></tr></thead>
            <tbody>
              {ö.fel.map((f) => (
                <tr key={`${f.källa}${f.väg}${f.meddelande}`}>
                  <td>{f.källa}{f.väg ? ` ${f.metod || ''} ${f.väg}` : ''}</td>
                  <td className="dim">{f.meddelande}</td>
                  <td>{f.antal}</td>
                  <td className="dim">{fmtDate(f.senast)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="dash-block">
        <div className="dash-stat-label">Användare</div>
        <table className="dash-table">
          <thead>
            <tr>
              <th>Konto</th><th>Skapat</th><th>Senast aktiv</th><th>AI 30 d</th>
              <th>Skickade</th><th>Kampanjer</th><th>Gmail</th><th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.email}
                  {u.du && <span className="dash-tag">du</span>}
                  {u.role === 'admin' && <span className="dash-tag">admin</span>}
                  {u.disabled_at && <span className="dash-tag gone">spärrad</span>}
                  {!u.google && <span className="dash-tag">lösenord</span>}
                </td>
                <td className="dim">{fmtDate(u.created_at)}</td>
                <td className="dim">{u.senast_aktiv ? fmtDate(u.senast_aktiv) : '—'}</td>
                <td>{kr(u.kostnad_30d)}</td>
                <td>{u.skickade}</td>
                <td>{u.aktiva_kampanjer}</td>
                <td className={u.gmail_error ? 'good' : 'dim'} title={u.gmail_error || ''}>
                  {u.gmail ? 'kopplat' : u.gmail_error ? 'fel' : '—'}
                </td>
                <td>
                  {u.role !== 'admin' && !u.du && (
                    <button className="btn" type="button" disabled={busy === u.id}
                      onClick={() => spärr(u, !u.disabled_at)}>
                      {busy === u.id ? '…' : u.disabled_at ? 'Lås upp' : 'Spärra'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          Bara siffror. Användarnas CV, brev och mejl visas aldrig här. Admin sätts med
          {' '}<code>node scripts/make-admin.js &lt;e-post&gt;</code>.
        </p>
      </section>
    </div>
  );
}
