'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import ChatTools from './ChatTools.jsx';
import CvUpload from './CvUpload.jsx';

// One pane, two conversations: search criteria (per saved search,
// persisted in search_messages) and letter revision (per draft).
export default function Chat({ mode, search, creatingSearch, onCreateSearch, letterState, onLetterRevised, onSearchChanged }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [letterLog, setLetterLog] = useState([]);
  const [cv, setCv] = useState(null);
  const bodyRef = useRef(null);

  const isLetter = mode === 'letter';
  // No CV means scoring and letters can't run at all, so the chat
  // asks for one first instead of letting the user write criteria
  // that silently produce nothing.
  const needsCv = !isLetter && cv?.active === 'none';

  useEffect(() => {
    if (isLetter) return;
    api('/api/cv').then(setCv).catch(() => {});
  }, [isLetter, search?.id]);

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

      {!isLetter && !creatingSearch && search?.id && (
        <ChatTools
          search={search}
          onChanged={onSearchChanged}
          onCvChanged={(d) => setCv(d)}
        />
      )}

      {needsCv && (
        <div className="cv-gate">
          <div className="cv-gate-head">Ladda upp ditt CV först</div>
          <p>
            Matchningen läser hela annonstexten mot ditt CV. Utan CV kan inga
            annonser bedömas och inga brev skrivas.
          </p>
          <CvUpload
            compact
            scope="profile"
            onDone={() => api('/api/cv').then(setCv).catch(() => {})}
          />
        </div>
      )}

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
            disabled={needsCv}
            placeholder={needsCv ? 'Ladda upp ett CV först…' : isLetter ? 'Beskriv en ändring…' : creatingSearch ? 'T.ex. junior frontend i Stockholm, gärna React…' : 'Justera kriterier…'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <button className="send-btn" onClick={() => send()} disabled={busy || needsCv}>→</button>
        </div>
      </div>
    </div>
  );
}
