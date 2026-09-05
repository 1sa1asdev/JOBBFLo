'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Dots from './Dots';

// ------------------------------------------------------------
// The ads a campaign cannot reach, and the work of reaching them.
//
// Most of a campaign's pool publishes no address — 1082 of 1149 here —
// so the campaign skips them silently. They are not bad matches, they
// are unreachable ones, and that is the largest single thing between the
// user and more applications.
//
// The app opens the page and reads it; the user decides. An address off
// a page can be a support desk, a webmaster or the wrong person
// entirely, and this is a tool for writing to strangers — so nothing is
// mailed on a machine's guess. Confirming is the whole interaction.
//
// Ordered by embedding distance, because these are worked one at a time
// and the order is the difference between an hour well spent and an
// hour wasted.
// ------------------------------------------------------------
export default function LeadFinder({ campaigns, onChanged }) {
  const [searchId, setSearchId] = useState(campaigns?.[0]?.id || null);
  const [data, setData] = useState(null);
  const [scan, setScan] = useState({});      // adId -> result
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState({});      // adId -> saved address
  const [typed, setTyped] = useState({});
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    if (!searchId) return;
    try { setData(await api(`/api/autoapply/leads?search=${searchId}`)); }
    catch (e) { setErr(e.message); }
  }, [searchId]);

  useEffect(() => { setData(null); load(); }, [load]);

  async function runScan(adId) {
    setBusy(adId); setErr(null);
    try {
      // Awaited before the state update, not inside it: the updater
      // passed to setScan is not async, and putting the call there is a
      // build error rather than a runtime one.
      const result = await api('/api/autoapply/leads', { method: 'POST', body: { adId } });
      setScan((s) => ({ ...s, [adId]: result }));
    } catch (e) { setErr(e.message); }
    setBusy(null);
  }

  async function confirm(adId, email, source) {
    setBusy(adId); setErr(null);
    try {
      const r = await api('/api/autoapply/leads', { method: 'PATCH', body: { adId, email, source } });
      setDone((d) => ({ ...d, [adId]: r.apply_email }));
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(null);
  }

  if (!campaigns?.length) {
    return <div className="loading-note">Skapa en kampanj först — adresserna hör till en kampanjs annonser.</div>;
  }
  if (!data) return <div className="loading-note">{err || <>Laddar<Dots /></>}</div>;

  return (
    <div className="auto-body">
      <div className="auto-head">
        <div className="idx">06 / Hitta adresser</div>
        <h2>Annonser utan mejladress</h2>
        <p className="auto-lede">
          <b>{data.total.toLocaleString('sv-SE')}</b> annonser i kampanjen publicerar ingen
          adress, så kampanjen kan inte skriva till dem. Appen öppnar sidan och läser den —
          du avgör om adressen är rätt. {data.ranked
            ? 'Sorterade efter hur nära de ligger ditt CV, så det översta är värt mest tid.'
            : 'Sorterade efter datum tills kampanjen har en sökvektor.'}
        </p>
      </div>

      {campaigns.length > 1 && (
        <div className="cl-picker">
          {campaigns.map((c) => (
            <button key={c.id} className={`cl-pick${c.id === searchId ? ' active' : ''}`}
              onClick={() => setSearchId(c.id)}>{c.name}</button>
          ))}
        </div>
      )}

      {err && <div className="err-note" style={{ margin: '0 0 12px' }}>{err}</div>}

      <div className="lead-list">
        {data.leads.map((l) => {
          const s = scan[l.id];
          const saved = done[l.id];
          return (
            <div className={`lead-item${saved ? ' saved' : ''}`} key={l.id}>
              <div className="lead-head">
                <div className="lead-title">
                  {l.title}
                  <span className="lead-emp">{l.employer}{l.municipality ? ` — ${l.municipality}` : ''}</span>
                </div>
                <a className="lead-link" href={l.apply_url} target="_blank" rel="noreferrer">
                  {l.host} ↗
                </a>
              </div>

              {saved ? (
                <div className="lead-saved">✓ {saved} — annonsen ingår nu i kampanjen</div>
              ) : (
                <>
                  <div className="lead-acts">
                    <button className="btn" disabled={busy === l.id} onClick={() => runScan(l.id)}>
                      {busy === l.id ? <>Läser sidan<Dots label="Läser" /></> : s ? 'Läs om' : 'Läs sidan'}
                    </button>
                    <input
                      className="ct-input" placeholder="eller skriv adressen själv"
                      value={typed[l.id] || ''}
                      onChange={(e) => setTyped((t) => ({ ...t, [l.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                          confirm(l.id, e.currentTarget.value.trim(), 'manual');
                        }
                      }}
                    />
                  </div>

                  {s && (s.ok ? (
                    <div className="lead-found">
                      <span className="lead-found-label">Hittade på sidan — välj rätt:</span>
                      {s.emails.map((e) => (
                        <button key={e} className="lead-mail" disabled={busy === l.id}
                          onClick={() => confirm(l.id, e, 'scanned')}>{e}</button>
                      ))}
                    </div>
                  ) : (
                    <div className="lead-none">
                      {s.reason} — öppna länken och leta själv, eller hoppa över.
                    </div>
                  ))}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
