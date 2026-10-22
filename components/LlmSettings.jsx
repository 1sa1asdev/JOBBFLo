'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Dots from './Dots';
import CostEstimate from './CostEstimate.jsx';

// ------------------------------------------------------------
// The user's AI: OpenRouter, LM Studio or Ollama (src/providers.js).
//
// OpenRouter offers the operator's list of models per job, with
// OpenRouter's price beside each (src/modeller.js) — not the provider's
// hundreds. LM Studio and Ollama list whatever the user's own server has
// loaded, from an address the server is allowed to call (src/adress.js).
//
// onSaved: the onboarding guide moves on once a provider is saved.
// ------------------------------------------------------------

// Rows in the order a user thinks about them, with what each one costs.
const FÄLT = [
  ['bulk', 'Bedömning', '~90 % av kostnaden'],
  ['write', 'Brev och svar', 'det du läser'],
  ['fast', 'Läsa krav och klassa svar', 'snabb'],
  ['smart', 'Reserv', 'om något fält är tomt'],
];

const pris = (m) => (m.in == null ? 'pris okänt'
  : `$${m.in} in / $${m.ut} ut per miljon tokens`);

export default function LlmSettings({ onSaved } = {}) {
  const [data, setData] = useState(null);
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [val, setVal] = useState({ fast: '', bulk: '', write: '', smart: '' });
  const [baseUrl, setBaseUrl] = useState('');
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [listor, setListor] = useState(null);          // OpenRouter: { fast: [{id,in,ut}], … }
  const [lokala, setLokala] = useState(null);          // LM Studio / Ollama: [{id}]
  const [laddar, setLaddar] = useState(false);
  const [listFel, setListFel] = useState(null);
  const [blocked, setBlocked] = useState({});          // model -> minutes left

  const meta = data?.providers.find((p) => p.id === provider) || null;
  const sätt = (nivå, v) => { setVal((x) => ({ ...x, [nivå]: v })); setSaved(false); };

  useEffect(() => {
    api('/api/settings/llm').then((d) => {
      setData(d);
      setProvider(d.current.provider || '');
      setVal({ fast: d.current.model_fast || '', bulk: d.current.model_bulk || '',
        write: d.current.model_write || '', smart: d.current.model_smart || '' });
      setBaseUrl(d.current.base_url || '');
      setBlocked(d.blocked || {});
      if (d.current.provider) laddaModeller(d.current.provider, d.current.base_url || '');
    }).catch((e) => setError(e.message));
  }, []);

  // keep the "out of tokens" markers honest while the panel is open
  useEffect(() => {
    if (!provider) return undefined;
    const t = setInterval(async () => {
      if (document.hidden) return;
      try { setBlocked((await api('/api/settings/llm')).blocked || {}); } catch { /* next tick */ }
    }, 20_000);
    return () => clearInterval(t);
  }, [provider]);

  function välj(id) {
    const p = data?.providers.find((x) => x.id === id);
    setProvider(id);
    setTest(null); setSaved(false); setError(null);
    setListor(null); setLokala(null); setListFel(null); setBlocked({});
    // the recommended models, so the fields are never blank
    setVal({ fast: p?.fast || '', bulk: p?.bulk || '', write: p?.write || '', smart: p?.smart || '' });
    setBaseUrl('');
    laddaModeller(id, '');
  }

  async function laddaModeller(pid = provider, bUrl = baseUrl) {
    if (!pid) return;
    setLaddar(true); setListFel(null);
    try {
      const params = new URLSearchParams({ provider: pid });
      if (bUrl) params.set('base_url', bUrl);
      const d = await api(`/api/settings/llm/models?${params}`);
      if (d.modeller) setListor(d.modeller);
      else if (d.error && !d.models?.length) throw new Error(d.error);
      else setLokala(d.models || []);
      setBlocked(d.blocked || {});
    } catch (e) { setListFel(e.message); }
    setLaddar(false);
  }

  // One job's control. OpenRouter: the allowed models only. Local: the
  // server's own list once loaded, free text until then.
  function kontroll(nivå) {
    const värde = (val[nivå] || '').split(',')[0].trim();
    const ändra = (e) => sätt(nivå, e.target.value);
    if (meta && !meta.lokal) {
      const lista = listor?.[nivå] || (data.modeller?.[nivå] || []).map((id) => ({ id }));
      return (
        <select className="txt-input" value={värde} onChange={ändra}>
          {!lista.some((m) => m.id === värde) && <option value={värde}>{värde || '—'} (inte längre valbar)</option>}
          {lista.map((m) => (
            <option key={m.id} value={m.id} disabled={blocked[m.id] != null}>
              {m.id}{blocked[m.id] != null ? ` · kvot slut (~${blocked[m.id]} min)` : listor ? ` · ${pris(m)}` : ''}
            </option>
          ))}
        </select>
      );
    }
    if (lokala?.length) {
      return (
        <select className="txt-input" value={värde} onChange={ändra}>
          {!lokala.some((m) => m.id === värde) && <option value={värde}>{värde || '—'}</option>}
          {lokala.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
        </select>
      );
    }
    return <input className="txt-input" type="text" value={val[nivå]} onChange={ändra} placeholder="modellens namn" />;
  }

  async function runTest() {
    setBusy('test'); setTest(null); setError(null);
    try {
      setTest(await api('/api/settings/llm/test', {
        method: 'POST',
        body: { provider, api_key: apiKey, model_smart: val.smart || val.bulk, base_url: baseUrl },
      }));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function save() {
    setBusy('save'); setError(null); setSaved(false);
    try {
      const r = await api('/api/settings/llm', {
        method: 'PUT',
        body: { provider, api_key: apiKey, model_smart: val.smart, model_fast: val.fast,
                model_bulk: val.bulk, model_write: val.write, base_url: meta?.lokal ? baseUrl : '' },
      });
      setApiKey('');
      setSaved(true);
      onSaved?.();
      setData((d) => ({ ...d, active: r.active, current: { ...d.current, provider, key_masked: d.current.key_masked || '••••' } }));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function clear() {
    setBusy('clear');
    try {
      await api('/api/settings/llm', { method: 'DELETE' });
      setProvider(''); setApiKey(''); setVal({ fast: '', bulk: '', write: '', smart: '' }); setBaseUrl('');
      setTest(null); setSaved(false); setListor(null); setLokala(null); setListFel(null); setBlocked({});
      setData(await api('/api/settings/llm'));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  if (!data) return <div className="loading-note">{error || <>Laddar<Dots /></>}</div>;

  return (
    <div className="field-group">
      <span className="label">AI-leverantör</span>

      <div className="llm-active">
        {data.active
          ? <>Använder nu: <b>{data.active.provider}</b> · {data.active.bulk || data.active.smart} — din egen nyckel, din egen kostnad</>
          : <>Ingen leverantör vald — bedömning och brev är avstängda tills du väljer en nedan.</>}
      </div>

      <div className="llm-grid">
        {data.providers.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`llm-card${provider === p.id ? ' active' : ''}`}
            aria-pressed={provider === p.id}
            aria-label={`${p.label}${p.eu === true ? ' (data stannar hos dig)' : ''}`}
            onClick={() => välj(p.id)}
          >
            <span className="llm-name">
              {p.label}
              {p.eu === true && <i className="llm-eu" title="Data lämnar inte din dator">LOKALT</i>}
            </span>
            <span className="llm-note">{p.note}</span>
          </button>
        ))}
      </div>

      {meta && (
        <div className="llm-form">
          {meta.needsKey && (
            <label>
              <span>
                API-nyckel
                {data.current.key_masked && provider === data.current.provider &&
                  <> — sparad: <code>{data.current.key_masked}</code> (lämna tomt för att behålla)</>}
              </span>
              <input
                className="txt-input" type="password" autoComplete="off"
                placeholder={data.current.key_masked && provider === data.current.provider ? 'oförändrad' : 'klistra in nyckeln'}
                value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              />
              {meta.keyUrl && (
                <a className="llm-link" href={meta.keyUrl} target="_blank" rel="noreferrer">
                  Hämta nyckel hos {meta.label} → (sätt gärna en kreditgräns på den)
                </a>
              )}
            </label>
          )}

          {meta.lokal && (
            <label>
              <span>Adress till din modellserver</span>
              <input className="txt-input" type="text" placeholder="https://…/v1"
                value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setSaved(false); }}
                onBlur={() => laddaModeller()} />
              <span className="tier-note">
                Kör du Jobbflo på din egen dator räcker den lokala adressen. I den publicerade appen
                måste det vara en publik https-adress, till exempel en tunnel till din dator — servern
                anropar aldrig localhost eller interna nät åt dig.
              </span>
            </label>
          )}

          <div className="two-col">
            {FÄLT.map(([nivå, namn, not]) => (
              <label key={nivå}>
                <span>{namn} <i className="tier-note">{not}</i></span>
                {kontroll(nivå)}
              </label>
            ))}
          </div>

          {meta.lokal && (
            <div className="llm-models-head">
              <button className="btn" type="button" onClick={() => laddaModeller()} disabled={busy || laddar}>
                {laddar ? <>Laddar<Dots /></> : 'Hämta modeller från servern'}
              </button>
            </div>
          )}
          {listFel && <div className="err-note" style={{ margin: '8px 0 0' }}>{listFel}</div>}

          {!meta.lokal && (
            <p className="hint">
              Modellerna är de Jobbflo är testat och prissatt med. Bedömningen står för det mesta
              av kostnaden och klarar en billig modell; breven är få men är det du faktiskt läser.
            </p>
          )}

          <CostEstimate
            provider={provider} fast={val.fast} bulk={val.bulk} write={val.write}
            onRekommendera={(r) => { setVal({ fast: r.fast, bulk: r.bulk, write: r.write, smart: r.smart }); setSaved(false); }}
          />

          {test && (
            <div className={test.ok ? 'llm-test ok' : 'llm-test fail'}>
              {test.ok
                ? `✓ Anslutning OK — ${test.model} svarade på ${test.ms} ms`
                : `✗ ${test.error}`}
            </div>
          )}
          {error && <div className="err-note" style={{ margin: '10px 0 0' }}>{error}</div>}

          <div className="llm-acts">
            <button className="btn" type="button" onClick={runTest} disabled={busy}>
              {busy === 'test' ? 'Testar…' : 'Testa anslutning'}
            </button>
            <button className="btn primary" type="button" onClick={save} disabled={busy}>
              {busy === 'save' ? 'Sparar…' : 'Spara leverantör'}
            </button>
            {data.current.provider && (
              <button className="btn" type="button" onClick={clear} disabled={busy}>Nollställ</button>
            )}
            {saved && <span className="gate-status">✓ Sparat</span>}
          </div>
        </div>
      )}

      <p className="hint llm-gdpr">
        <b>Om personuppgifter:</b> ditt CV, dina kontaktuppgifter och mejl från arbetsgivare skickas
        till den AI du väljer. Via OpenRouter går de vidare till modellens tillverkare (till exempel
        Google eller OpenAI), ofta utanför EU. LM Studio och Ollama körs på din egen dator och skickar
        ingenting vidare.
      </p>
    </div>
  );
}
