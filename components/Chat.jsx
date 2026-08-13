'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// One pane, two conversations: search criteria (per saved search,
// persisted in search_messages) and letter revision (per draft).
export default function Chat({ mode, search, creatingSearch, onCreateSearch, letterState, onLetterRevised }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [letterLog, setLetterLog] = useState([]);
  const bodyRef = useRef(null);

  const isLetter = mode === 'letter';

  useEffect(() => {
    setError(null);
    if (!isLetter && search?.id) {
      api(`/api/searches/${search.id}`)
        .then((s) => setMessages(s.messages || []))
        .catch((e) => setError(e.message));
    } else if (!search?.id) {
      setMessages([]);
    }
  }, [search?.id, isLetter]);

  useEffect(() => {
    if (isLetter) setLetterLog([]);
  }, [isLetter, letterState?.application?.id]);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [messages, letterLog, busy]);

  async function send(text) {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput('');
    setError(null);
    setBusy(true);
    try {
      if (creatingSearch) {
        await onCreateSearch(content);
      } else if (isLetter) {
        if (!letterState?.application) throw new Error('inget utkast att revidera än');
        setLetterLog((l) => [...l, { role: 'user', content }]);
        const app = await api(`/api/applications/${letterState.application.id}/revise`, {
          method: 'POST',
          body: { instruction: content },
        });
        setLetterLog((l) => [...l, { role: 'assistant', content: app.change_note || 'Klart — brevet är uppdaterat.' }]);
        onLetterRevised(app);
      } else if (search?.id) {
        setMessages((m) => [...m, { role: 'user', content }]);
        const res = await api(`/api/searches/${search.id}/messages`, {
          method: 'POST',
          body: { message: content },
        });
        setMessages((m) => [...m, { role: 'assistant', content: res.reply }]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const shown = isLetter ? letterLog : messages;
  const quick = ['Kortare', 'Mindre formellt', 'Mer konkret', 'Skriv om helt'];

  return (
    <div className="chat">
      <div className="chat-header">
        <div className="idx">{isLetter ? '02 / Revidering' : '01 / Copilot'}</div>
        <h1>{isLetter ? 'Ändra brevet' : creatingSearch ? 'Ny sökning' : 'Vad letar du efter?'}</h1>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {creatingSearch && (
          <div className="sys-note">Beskriv med egna ord vad du söker — roller, ort, undantag</div>
        )}
        {isLetter && !letterLog.length && (
          <div className="sys-note">
            {letterState?.application
              ? `Version ${letterState.application.letter_version} — beskriv en ändring nedan`
              : 'Utkast genereras…'}
          </div>
        )}
        {shown.map((m, i) => (
          <div key={i} className={`msg ${m.role === 'user' ? 'user' : 'ai'}`}>
            <span className="who">{m.role === 'user' ? 'DU' : 'COPILOT'}</span>
            {m.content}
          </div>
        ))}
        {busy && <div className="sys-note">tänker…</div>}
        {error && <div className="sys-note">fel: {error}</div>}
      </div>

      {isLetter && letterState?.application && (
        <div className="quick">
          {quick.map((q) => (
            <button key={q} onClick={() => send(q)} disabled={busy}>{q}</button>
          ))}
        </div>
      )}

      <div className="chat-input">
        <div className="chat-input-box">
          <textarea
            rows={creatingSearch ? 3 : 1}
            value={input}
            placeholder={isLetter ? 'Beskriv en ändring…' : creatingSearch ? 'T.ex. junior frontend i Stockholm, gärna React…' : 'Justera kriterier…'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <button className="send-btn" onClick={() => send()} disabled={busy}>→</button>
        </div>
      </div>
    </div>
  );
}
