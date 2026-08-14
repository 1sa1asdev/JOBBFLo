'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Dots from './Dots';

export default function LlmSettings() {
  const [data, setData] = useState(null);
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [smart, setSmart] = useState('');
  const [fast, setFast] = useState('');
  const [bulk, setBulk] = useState('');
  const [write, setWrite] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [modelData, setModelData] = useState(null);      // { models, pricing_reported }
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState(null);
  const [freeOnly, setFreeOnly] = useState(true);
  const [blocked, setBlocked] = useState({});            // model -> minutes left

  useEffect(() => {
    api('/api/settings/llm').then((d) => {
      setData(d);
      setProvider(d.current.provider || '');
      setSmart(d.current.model_smart || '');
      setFast(d.current.model_fast || '');
      setBulk(d.current.model_bulk || '');
      setWrite(d.current.model_write || '');
      setBaseUrl(d.current.base_url || '');
      setBlocked(d.blocked || {});
      if (d.current.provider) loadModels(d.current.provider, d.current.base_url || '');
    }).catch((e) => setError(e.message));
  }, []);

  // keep the "out of tokens" markers honest while the panel is open:
  // llm.js records blocked models in-memory as calls fail, so poll the
  // light settings endpoint and refresh the map (not the provider list).
  useEffect(() => {
    if (!provider) return undefined;
    const t = setInterval(async () => {
      if (document.hidden) return;
      try {
        const d = await api('/api/settings/llm');
        setBlocked(d.blocked || {});
      } catch { /* transient — next tick retries */ }
    }, 20_000);
    return () => clearInterval(t);
  }, [provider]);

  const meta = data?.providers.find((p) => p.id === provider) || null;

  function pick(id) {
    setProvider(id);
    setTest(null);
    setSaved(false);
    setModelData(null);
    setModelsError(null);
    setBlocked({});
    const p = data?.providers.find((x) => x.id === id);
    // prefill the provider's defaults so the fields are never blank
    setSmart(p?.smart || '');
    setFast(p?.fast || '');
    setBulk(p?.bulk || '');
    setWrite(p?.write || '');
    setBaseUrl('');
    loadModels(id);
  }

  async function loadModels(pid = provider, bUrl = baseUrl) {
    if (!pid) return;
    setLoadingModels(true);
    setModelsError(null);
    setModelData(null);
    try {
      const params = new URLSearchParams();
      params.set('provider', pid);
      if (bUrl) params.set('base_url', bUrl);
      // a key typed in but not yet saved lets the list load anyway
      if (apiKey) params.set('api_key', apiKey);
      const res = await fetch(`/api/settings/llm/models?${params}`);
      const d = await res.json();
      if (!res.ok || (d.error && !d.models?.length)) {
        throw new Error(d.error || 'kunde inte hämta modeller');
      }
      setModelData({ models: d.models || [], pricing_reported: d.pricing_reported });
      setBlocked(d.blocked || {});
    } catch (e) {
      setModelsError(e.message);
    }
    setLoadingModels(false);
  }

  // --- model dropdowns -------------------------------------------------
  const list = modelData?.models || [];
  const freeList = list.filter((m) => m.free === true);
  const pickable = freeOnly && freeList.length > 0 ? freeList : list;
  const pricingUnknown = modelData?.pricing_reported === false;
  const blockedEntries = Object.entries(blocked);

  // options for one field: the pickable models, plus the field's current
  // value even if it's not in the list (custom ids and fallback chains)
  function modelOptions(current) {
    const seen = new Set();
    const opts = pickable.map((m) => {
      seen.add(m.id);
      const mins = blocked[m.id];
      return (
        <option key={m.id} value={m.id} disabled={mins != null}>
          {m.id}
          {mins != null ? ` · kvot slut (~${mins} min)` : m.free ? ' · gratis' : ''}
        </option>
      );
    });
    if (current && !seen.has(current)) {
      opts.unshift(<option key={current} value={current}>{current}</option>);
    }
    return opts;
  }

  // a dropdown once models are loaded; a text input otherwise (so chains
  // can be typed by hand and nothing blocks a provider without /models)
  function fieldControl(value, setter, placeholder) {
    const apply = (e) => { setter(e.target.value); setSaved(false); };
    if (pickable.length === 0) {
      return (
        <input className="txt-input" type="text" placeholder={placeholder}
          value={value} onChange={apply} />
      );
    }
    const single = (value || '').split(',')[0].trim();
    return (
      <select className="txt-input" value={single} onChange={apply}>
        <option value="">—</option>
        {modelOptions(single)}
      </select>
    );
  }

  async function runTest() {
    setBusy('test'); setTest(null); setError(null);
    try {
      setTest(await api('/api/settings/llm/test', {
        method: 'POST',
        body: { provider, api_key: apiKey, model_smart: smart, base_url: baseUrl },
      }));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function save() {
    setBusy('save'); setError(null); setSaved(false);
    try {
      const r = await api('/api/settings/llm', {
        method: 'PUT',
        body: { provider, api_key: apiKey, model_smart: smart, model_fast: fast,
                model_bulk: bulk, model_write: write, base_url: baseUrl },
      });
      setApiKey('');
      setSaved(true);
      setData((d) => ({ ...d, active: r.active, current: { ...d.current, provider, key_masked: d.current.key_masked || '••••' } }));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function clear() {
    setBusy('clear');
    try {
      await api('/api/settings/llm', { method: 'DELETE' });
      setProvider(''); setApiKey(''); setSmart(''); setFast(''); setBulk(''); setWrite(''); setBaseUrl('');
      setTest(null); setSaved(false); setModelData(null); setModelsError(null); setBlocked({});
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
          ? <>Använder nu: <b>{data.active.provider}</b> · {data.active.smart}
              {data.active.source === 'env' && <span className="llm-src"> (från serverns .env)</span>}</>
          : <>Ingen leverantör konfigurerad — poängsättning och brev är avstängda.</>}
      </div>

      <div className="llm-grid">
        {data.providers.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`llm-card${provider === p.id ? ' active' : ''}`}
            aria-pressed={provider === p.id}
            aria-label={`${p.label}${p.eu === true ? ' (data inom EU)' : ''}`}
            onClick={() => pick(p.id)}
          >
            <span className="llm-name">
              {p.label}
              {p.eu === true && <i className="llm-eu" title="Data behandlas inom EU">EU</i>}
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
                  Hämta nyckel hos {meta.label} →
                </a>
              )}
            </label>
          )}

          {meta.needsBaseUrl && (
            <label>
              <span>Bas-URL (OpenAI-kompatibel endpoint)</span>
              <input className="txt-input" type="text" placeholder="https://…/v1"
                value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
          )}

          <div className="two-col">
            <label>
              <span>Modell — poängsättning <i className="tier-note">~90% av kostnaden</i></span>
              {fieldControl(bulk, setBulk, smart || 'billig modell')}
            </label>
            <label>
              <span>Modell — brev &amp; svar <i className="tier-note">läses av dig</i></span>
              {fieldControl(write, setWrite, smart || 'bra modell')}
            </label>
            <label>
              <span>Modell — klassificering <i className="tier-note">snabb</i></span>
              {fieldControl(fast, setFast, '')}
            </label>
            <label>
              <span>Reservmodell <i className="tier-note">används om fälten ovan är tomma</i></span>
              {fieldControl(smart, setSmart, '')}
            </label>
          </div>

          <div className="llm-models">
            <div className="llm-models-head">
              <button className="btn" type="button" onClick={() => loadModels()} disabled={busy || loadingModels}>
                {loadingModels ? <>Laddar<Dots /></> : 'Ladda om modeller'}
              </button>
              {modelData && (
                <>
                  <label className="llm-freeonly">
                    <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
                    Endast gratis
                  </label>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => loadModels()}
                    disabled={loadingModels}
                    title="Uppdatera listan och tillgängligheten"
                  >
                    ↻
                  </button>
                </>
              )}
            </div>

            {modelsError && <div className="err-note" style={{ margin: '8px 0 0' }}>{modelsError}</div>}

            {modelData && !modelsError && (
              <div className="llm-models-body">
                {blockedEntries.length > 0 && (
                  <div className="llm-blocked">
                    <span className="llm-blocked-title">Slut på dagskvot — välj en annan:</span>
                    {blockedEntries.map(([m, mins]) => (
                      <span className="tag" key={m}>{m} · ~{mins} min</span>
                    ))}
                  </div>
                )}

                {freeOnly && freeList.length === 0 && pricingUnknown && (
                  <p className="hint">
                    {meta.label} rapporterar inte priser via /models — "gratis" går inte att avgöra,
                    så listan visar alla modeller.
                  </p>
                )}
                {freeOnly && freeList.length === 0 && !pricingUnknown && (
                  <p className="hint">Inga gratis modeller hos {meta.label} — visar alla.</p>
                )}
              </div>
            )}
          </div>

          <p className="hint">
            Poängsättningen står för ~90% av tokens men tål en billig modell; breven är få
            men är det du faktiskt läser. Att dela dem är skillnaden mellan ca 20 kr och
            ca 200 kr i månaden. Flera modeller kan anges kommaseparerat — de provas i tur
            och ordning, bra för "betald först, gratis som reserv".
          </p>

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
        <b>Om personuppgifter:</b> ditt CV, dina kontaktuppgifter och mejl från arbetsgivare
        skickas till den leverantör du väljer. Leverantörer märkta <i className="llm-eu">EU</i>{' '}
        behandlar data inom EU/EES, vilket är enklare att motivera enligt GDPR. Ollama körs
        lokalt och skickar ingenting alls.
      </p>
    </div>
  );
}
