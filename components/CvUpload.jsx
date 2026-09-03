'use client';
import { useRef, useState } from 'react';

// ------------------------------------------------------------
// CV upload, used in two places:
//   scope="profile" — the base CV (Profil)
//   scope="search"  — a CV tailored for one search (chatten)
// Falls back to pasting text, because scanned PDFs contain no
// extractable text and would otherwise be a dead end.
// ------------------------------------------------------------
export default function CvUpload({ scope = 'profile', searchId = null, current, onDone, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  async function send(formData) {
    setBusy(true); setError(null); setWarning(null);
    try {
      const res = await fetch('/api/cv', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'uppladdningen misslyckades');
      if (data.warning) setWarning(data.warning);
      setPasting(false); setPasted('');
      onDone?.(data);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  function upload(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    if (scope === 'search' && searchId) fd.append('searchId', searchId);
    send(fd);
  }

  function uploadText() {
    if (!pasted.trim()) return;
    const fd = new FormData();
    fd.append('text', pasted);
    if (scope === 'search' && searchId) fd.append('searchId', searchId);
    send(fd);
  }

  // Removing the base CV takes the derived profile with it, and without
  // a CV nothing can be scored or written — so it asks first. The
  // confirmation replaces the button in place rather than opening a
  // dialog, which is harder to click through by reflex.
  async function clearProfileCv() {
    setBusy(true);
    try {
      const res = await fetch('/api/cv', { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'kunde inte ta bort');
      setConfirming(false);
      onDone?.({ cleared: true });
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function clearSearchCv() {
    setBusy(true);
    try {
      await fetch(`/api/cv?search=${searchId}`, { method: 'DELETE' });
      onDone?.({ cleared: true });
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className={`cvup${compact ? ' compact' : ''}`}>
      <div
        className={`cvup-zone${dragging ? ' drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files?.[0]); }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          style={{ display: 'none' }}
          onChange={(e) => upload(e.target.files?.[0])}
        />
        {current ? (
          <div className="cvup-current">
            <span className="cvup-file">{current.filename}</span>
            <span className="cvup-meta">{Math.round(current.chars / 100) / 10}k tecken</span>
            {scope === 'profile' && (confirming ? (
              <span className="cvup-confirm">
                Ta bort CV:t och allt som lästs ut ur det?
                <button className="danger" disabled={busy}
                  onClick={(e) => { e.stopPropagation(); clearProfileCv(); }}>Ta bort</button>
                <button onClick={(e) => { e.stopPropagation(); setConfirming(false); }}>Avbryt</button>
              </span>
            ) : (
              <button className="cvup-del" title="Ta bort bas-CV:t"
                onClick={(e) => { e.stopPropagation(); setConfirming(true); }}>Ta bort</button>
            ))}
          </div>
        ) : (
          <span className="cvup-hint">
            {compact ? 'Dra hit ditt CV eller' : 'Släpp CV:t här — PDF, DOCX eller TXT, max 10 MB'}
          </span>
        )}
        <div className="cvup-acts">
          <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Läser…' : current ? 'Ersätt' : 'Välj fil'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setPasting(!pasting)}>
            {pasting ? 'Avbryt' : 'Klistra in text'}
          </button>
          {scope === 'search' && current && (
            <button type="button" className="btn" disabled={busy} onClick={clearSearchCv}>
              Använd bas-CV
            </button>
          )}
        </div>
      </div>

      {pasting && (
        <div className="cvup-paste">
          <textarea
            className="txt-area"
            placeholder="Klistra in CV-texten här (bra för inskannade PDF:er)"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <button type="button" className="btn primary" disabled={busy || !pasted.trim()} onClick={uploadText}>
            Spara text
          </button>
        </div>
      )}

      {error && <div className="err-note" style={{ margin: '8px 0 0' }}>{error}</div>}
      {warning && <div className="cvup-warn">⚠ {warning} — kontrollera att rätt fil laddades upp.</div>}
    </div>
  );
}
