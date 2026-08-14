'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

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

  useEffect(() => {
    api('/api/settings/llm').then((d) => {
      setData(d);
      setProvider(d.current.provider || '');
      setSmart(d.current.model_smart || '');
      setFast(d.current.model_fast || '');
      setBulk(d.current.model_bulk || '');
      setWrite(d.current.model_write || '');
      setBaseUrl(d.current.base_url || '');
    }).catch((e) => setError(e.message));
  }, []);

  const meta = data?.providers.find((p) => p.id === provider) || null;

  function pick(id) {
    setProvider(id);
    setTest(null);
    setSaved(false);
    const p = data?.providers.find((x) => x.id === id);
    // prefill the provider's defaults so the fields are never blank
    setSmart(p?.smart || '');
    setFast(p?.fast || '');
    setBulk(p?.bulk || '');
    setWrite(p?.write || '');
    setBaseUrl('');
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
      setTest(null); setSaved(false);
      setData(await api('/api/settings/llm'));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  if (!data) return <div className="loading-note">{error || 'Laddar…'}</div>;

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
              <input className="txt-input" type="text" placeholder={smart || 'billig modell'}
                value={bulk} onChange={(e) => setBulk(e.target.value)} />
            </label>
            <label>
              <span>Modell — brev &amp; svar <i className="tier-note">läses av dig</i></span>
              <input className="txt-input" type="text" placeholder={smart || 'bra modell'}
                value={write} onChange={(e) => setWrite(e.target.value)} />
            </label>
            <label>
              <span>Modell — klassificering <i className="tier-note">snabb</i></span>
              <input className="txt-input" type="text" value={fast} onChange={(e) => setFast(e.target.value)} />
            </label>
            <label>
              <span>Reservmodell <i className="tier-note">används om fälten ovan är tomma</i></span>
              <input className="txt-input" type="text" value={smart} onChange={(e) => setSmart(e.target.value)} />
            </label>
          </div>
          <p className="hint">
            Poängsättningen står för ~90% av tokens men tål en billig modell; breven är få
            men är det du faktiskt läser. Att dela dem är skillnaden mellan ca 20 kr och
            ca 200 kr i månaden. Flera modeller kan anges kommaseparerat — de provas i tur
            och ordning, bra för “betald först, gratis som reserv”.
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
