'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// ------------------------------------------------------------
// Co-authoring the campaign letter, mirroring the search chat:
// you say what to change, the AI rewrites, and the letter beside
// it updates. Nothing sends until you tick "godkänn" — and any
// further edit clears that tick, so what goes out is always text
// you have read in its final form.
// ------------------------------------------------------------
export default function CampaignLetter({ search, onChanged }) {
  const [data, setData] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const bodyRef = useRef(null);

  const load = useCallback(async () => {
    if (!search?.id) return;
    try { setData(await api(`/api/autoapply/letter?search=${search.id}`)); }
    catch (e) { setError(e.message); }
  }, [search?.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); }, [data, busy]);

  async function send(instruction) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await api('/api/autoapply/letter', {
        method: 'POST', body: { searchId: search.id, instruction: instruction || null },
      });
      setInput('');
      await load();
      onChanged?.();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function approve(next) {
    setBusy(true); setError(null);
    try {
      await api('/api/autoapply/letter', {
        method: 'PATCH', body: { searchId: search.id, approved: next },
      });
      await load();
      onChanged?.();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  if (!search) return <div className="loading-note">Välj en kampanj</div>;
  if (!data) return <div className="loading-note">{error || 'Laddar…'}</div>;

  const letter = data.letter;
  const shown = letter;   // sent exactly as written
  const approved = Boolean(data.approved_at);
  const quick = ['Kortare', 'Mindre formellt', 'Mer konkret', 'Lyft fram projekten', 'Skriv om helt'];

  return (
    <div className="cl-wrap">
      <div className="cl-chat">
        <div className="chat-header">
          <div className="idx">05 / Kampanjbrev</div>
          <h1>{letter ? 'Ändra brevet' : 'Skriv kampanjbrevet'}</h1>
        </div>

        <div className="chat-body" ref={bodyRef}>
          <div className="sys-note">
Ett kallt mejl — skickas oförändrat till alla annonser som matchar reglerna
          </div>
          {!letter && (
            <div className="msg ai">
              <span className="who">COPILOT</span>
              Jag skriver ett brev utifrån ditt CV och kampanjens regler
              ({search.criteria_text?.slice(0, 90)}…). Tryck nedan så börjar vi.
            </div>
          )}
          {(data.messages || []).map((m, i) => (
            <div key={i} className={`msg ${m.role === 'user' ? 'user' : 'ai'}`}>
              <span className="who">{m.role === 'user' ? 'DU' : 'COPILOT'}</span>
              {m.content}
            </div>
          ))}
          {busy && <div className="sys-note">skriver…</div>}
          {error && <div className="sys-note">fel: {error}</div>}
        </div>

        {letter && (
          <div className="quick">
            {quick.map((q) => (
              <button key={q} onClick={() => send(q)} disabled={busy}>{q}</button>
            ))}
          </div>
        )}

        <div className="chat-input">
          <div className="chat-input-box">
            <textarea
              rows={1}
              value={input}
              placeholder={letter ? 'Beskriv en ändring…' : 'Valfritt: säg hur brevet ska låta…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.trim() || null); }
              }}
            />
            <button className="send-btn" onClick={() => send(input.trim() || null)} disabled={busy}>
              {letter ? '→' : '✎'}
            </button>
          </div>
        </div>
      </div>

      <div className="cl-letter">
        <div className="pane-head">
          <span>{letter ? 'Kampanjbrev' : 'Inget brev än'}</span>

        </div>

        <div className="pane-scroll">
          {!letter ? (
            <p className="hint">
              Ett kallt mejl som skickas oförändrat till varje annons som klarar
              reglerna. Det som avgör om det fungerar är tydlig avsikt och en konkret
              pitch — inte att låtsas veta något om mottagaren.
            </p>
          ) : (
            <div className="sheet">
              {data.example && (
                <div className="cl-example">
                  Går bl.a. till <b>{data.example.ad.employer}</b> ({data.example.ad.score} p)
                  → {data.example.ad.apply_email} — exakt den här texten, oförändrad.
                </div>
              )}
              <div className="subject-line">
                <span className="lbl">Ämne</span>
                <span className="val">{shown.subject}</span>
              </div>
              <div className="letter">
                {String(shown.body || '').split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
              </div>
            </div>
          )}
        </div>

        {letter && (
          <div className="gate">
            <div className="recip">
              {approved
                ? <>✓ Godkänt {new Date(data.approved_at).toLocaleString('sv-SE')} — kampanjen får skicka det här brevet</>
                : <>Brevet är <b>inte godkänt</b>. Kampanjen skickar ingenting förrän du godkänner.</>}
            </div>
            <div className="acts">
              <button
                className={`btn${approved ? '' : ' primary'}`}
                disabled={busy}
                onClick={() => approve(!approved)}
              >
                {approved ? 'Återkalla godkännande' : 'Godkänn brevet →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
