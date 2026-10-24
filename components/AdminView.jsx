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

// The OpenRouter models users may pick, per job (src/modeller.js). An
// edited copy is kept here until "Spara"; the server checks every id
// against OpenRouter's catalogue before it is stored.
function Modellista({ modeller, onSpara, busy }) {
  const [utkast, setUtkast] = useState(() => Object.fromEntries(
    Object.entries(modeller).map(([n, v]) => [n, v.modeller.map((m) => m.id)])));
  const [ny, setNy] = useState({});
  const ändrad = Object.entries(modeller).some(([n, v]) => v.modeller.map((m) => m.id).join() !== utkast[n].join());
  const info = (n, id) => modeller[n].modeller.find((m) => m.id === id);

  return (
    <section className="dash-block">
      <div className="dash-stat-label">Modeller användarna kan välja (OpenRouter)</div>
      <p className="hint">
        Den första i varje lista är den rekommenderade och används när en användares val tagits
        bort. Gratismodeller tål inte riktig användning — de tar slut inom ett dygn.
      </p>
      {Object.entries(modeller).map(([n, v]) => (
        <div key={n} className="adm-modeller">
          <b>{v.namn}</b>
          <ul>
            {utkast[n].map((id, i) => {
              const m = info(n, id);
              return (
                <li key={id}>
                  <code>{id}</code>
                  {i === 0 && <span className="tag">rekommenderad</span>}
                  <span className="dim">
                    {m ? (m.in == null ? 'pris okänt' : `$${m.in} / $${m.ut} per miljon`) : 'ny — kontrolleras när du sparar'}
                    {m ? ` · ${m.användare} användare` : ''}
                    {m?.finns === false ? ' · finns inte längre hos OpenRouter' : ''}
                  </span>
                  <button type="button" className="btn" disabled={utkast[n].length <= 1}
                    onClick={() => setUtkast((u) => ({ ...u, [n]: u[n].filter((x) => x !== id) }))}>Ta bort</button>
                </li>
              );
            })}
          </ul>
          <form className="adm-ny" onSubmit={(e) => {
            e.preventDefault();
            const id = (ny[n] || '').trim();
            if (id && !utkast[n].includes(id)) setUtkast((u) => ({ ...u, [n]: [...u[n], id] }));
            setNy((x) => ({ ...x, [n]: '' }));
          }}>
            <input className="txt-input" placeholder="t.ex. anthropic/claude-haiku-4.5" value={ny[n] || ''}
              onChange={(e) => setNy((x) => ({ ...x, [n]: e.target.value }))} />
            <button className="btn" type="submit">Lägg till</button>
          </form>
        </div>
      ))}
      <button className="btn primary" type="button" disabled={!ändrad || busy} onClick={() => onSpara(utkast)}>
        {busy ? 'Sparar…' : 'Spara modellistan'}
      </button>
    </section>
  );
}

// The platform's embedding key, as each host holds it. Entered in
// Railway and Vercel, never here: a key typed into this page would have
// to be stored in the database, where a leak of the database — or of an
// admin session — hands it over with everything else. The hosts keep it
// encrypted and out of reach of the app's own queries. What this panel
// adds is the check that both hosts got the same key after a rotation.
function Plattformsnyckel({ n }) {
  const a = n.appen;
  const w = n.workern;
  const olika = a?.avtryck && w?.avtryck && a.avtryck !== w.avtryck;
  const rad = (namn, s) => (
    <tr>
      <td data-label="Var">{namn}</td>
      <td data-label="Nyckel" className={s?.satt ? '' : 'good'}>{s ? (s.satt ? 'satt' : 'saknas') : 'har inte rapporterat'}</td>
      <td data-label="Variabel" className="dim">{s?.källa || '—'}</td>
      <td data-label="Avtryck"><code>{s?.avtryck || '—'}</code></td>
    </tr>
  );
  return (
    <section className="dash-block">
      <div className="dash-stat-label">Plattformsnyckeln — embeddings</div>
      <div className="adm-scroll">
        <table className="dash-table adm-stack">
          <thead><tr><th>Var</th><th>Nyckel</th><th>Variabel</th><th>Avtryck</th></tr></thead>
          <tbody>
            {rad('Appen (Vercel)', a)}
            {rad('Workern (Railway)', w)}
          </tbody>
        </table>
      </div>
      {olika && <div className="err-note adm-note">Appen och workern har olika nycklar. Efter ett byte måste båda få den nya.</div>}
      <p className="hint">
        {n.senastFel && (!n.senastOk || new Date(n.senastFel.senast) > new Date(n.senastOk))
          ? <>Senaste indexeringen misslyckades {fmtDate(n.senastFel.senast)}: <i>{n.senastFel.not}</i>. </>
          : n.senastOk ? <>Senaste lyckade indexering {fmtDate(n.senastOk)}. </> : null}
        Avtrycket är början av nyckelns hash, så du ser om två ställen har samma nyckel utan att
        nyckeln visas. Nyckeln skrivs in i Railway och Vercel, inte här — då hamnar den aldrig i
        databasen.
      </p>
      <details className="adm-howto">
        <summary>Så byter du nyckeln</summary>
        <ol>
          <li>OpenRouter → Keys → skapa en ny nyckel, med en kreditgräns.</li>
          <li>Railway → <b>worker</b> → Variables → <code>PLATFORM_OPENROUTER_API_KEY</code> → klistra in → Deploy.</li>
          <li>Vercel → Settings → Environment Variables → samma namn, för Production → spara → Redeploy.</li>
          <li>Kontrollera här att avtrycken är lika och att indexeringen lyckas.</li>
          <li>Stäng av den gamla nyckeln hos OpenRouter.</li>
        </ol>
      </details>
    </section>
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

  async function sparaModeller(modeller) {
    setBusy('modeller'); setError(null);
    try { setÖ(await api('/api/admin/installningar', { method: 'PATCH', body: { modeller } })); }
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

  if (!ö || !users) return <div className="admin-page"><div className="loading-note">{error || <>Laddar<Dots /></>}</div></div>;
  const e = ö.embeddings;
  const w = ö.worker;
  const workerDöd = w.sekunderSedan == null || w.sekunderSedan > 120;

  // The page scrolls in its own container: body is the app shell and
  // does not scroll, which left everything below the first screen of
  // this page out of reach.
  return (
    <div className="admin-page">
    <div className="dash admin">
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

      <Plattformsnyckel n={ö.plattformsnyckel} />

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

      <Modellista key={JSON.stringify(ö.modeller)} modeller={ö.modeller}
        onSpara={sparaModeller} busy={busy === 'modeller'} />

      <section className="dash-block">
        <div className="dash-stat-label">Bakgrundsjobb</div>
        <div className="adm-scroll">
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
        </div>
      </section>

      <section className="dash-block">
        <div className="dash-stat-label">Fel som ingen fångade, senaste 7 dygnen</div>
        {ö.fel.length === 0 ? <p className="hint">Inga.</p> : (
          <div className="adm-scroll">
          <table className="dash-table adm-stack">
            <thead><tr><th>Var</th><th>Fel</th><th>Antal</th><th>Senast</th></tr></thead>
            <tbody>
              {ö.fel.map((f) => (
                <tr key={`${f.källa}${f.väg}${f.meddelande}`}>
                  <td data-label="Var">{f.källa}{f.väg ? ` ${f.metod || ''} ${f.väg}` : ''}</td>
                  <td data-label="Fel" className="dim">{f.meddelande}</td>
                  <td data-label="Antal">{f.antal}</td>
                  <td data-label="Senast" className="dim">{fmtDate(f.senast)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="dash-block">
        <div className="dash-stat-label">Användare</div>
        <div className="adm-scroll">
        <table className="dash-table adm-stack">
          <thead>
            <tr>
              <th>Konto</th><th>Skapat</th><th>Senast aktiv</th><th>AI 30 d</th>
              <th>Skickade</th><th>Kampanjer</th><th>Gmail</th><th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td data-label="Konto" className="adm-konto">
                  {u.email}
                  {u.du && <span className="dash-tag">du</span>}
                  {u.role === 'admin' && <span className="dash-tag">admin</span>}
                  {u.disabled_at && <span className="dash-tag gone">spärrad</span>}
                  {!u.google && <span className="dash-tag">lösenord</span>}
                </td>
                <td data-label="Skapat" className="dim">{fmtDate(u.created_at)}</td>
                <td data-label="Senast aktiv" className="dim">{u.senast_aktiv ? fmtDate(u.senast_aktiv) : '—'}</td>
                <td data-label="AI 30 d">{kr(u.kostnad_30d)}</td>
                <td data-label="Skickade">{u.skickade}</td>
                <td data-label="Kampanjer">{u.aktiva_kampanjer}</td>
                <td data-label="Gmail" className={u.gmail_error ? 'good' : 'dim'} title={u.gmail_error || ''}>
                  {u.gmail ? 'kopplat' : u.gmail_error ? 'fel' : '—'}
                </td>
                <td className="adm-act">
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
        </div>
        <p className="hint">
          Bara siffror. Användarnas CV, brev och mejl visas aldrig här. Admin sätts med
          {' '}<code>node scripts/make-admin.js &lt;e-post&gt;</code>.
        </p>
      </section>
    </div>
    </div>
  );
}
