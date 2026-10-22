'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ------------------------------------------------------------
// "Kom igång" — the path from a new account to a sent letter, at the top
// of Översikt.
//
// The first-run guide (/valkommen) covers the three things the app
// cannot work without. It ended on an overview full of zeros with no
// word on what to do next. This picks up there: every step from setup
// to the first sent letter, ticked from what the database says has
// happened (src/onboarding.js framsteg), each with the button that does
// it. It leaves once everything is done, can be hidden, and comes back
// from the link Översikt shows while it is hidden.
// ------------------------------------------------------------
const DOLD = 'jobbflo.komigang.dold';

function steg(s) {
  const f = s.framsteg || {};
  return [
    { id: 'gmail', klar: s.gmail, rubrik: 'Koppla din Gmail',
      text: 'Breven skickas från ditt eget Gmail och svaren läses därifrån. Du behöver ett applösenord från Google — guiden under Profil visar hur.',
      knapp: 'Öppna Profil', mål: 'profil' },
    { id: 'ai', klar: s.ai, rubrik: 'Välj AI och lägg in din nyckel',
      text: 'Bedömningar och brev görs med din egen AI-nyckel. Under Profil ser du ungefär vad dina val kostar i månaden innan något dras.',
      knapp: 'Öppna Profil', mål: 'profil' },
    { id: 'cv', klar: s.cv, rubrik: 'Ladda upp ditt CV',
      text: 'Varje annons bedöms mot ditt CV, krav för krav. Ladda upp det som PDF eller Word under Profil.',
      knapp: 'Öppna Profil', mål: 'profil' },
    { id: 'sok', klar: f.sökningar > 0, rubrik: 'Skapa din första sökning',
      text: 'Tryck + Ny sökning och beskriv jobbet med egna ord, till exempel ”junior frontend i Göteborg, heltid”. Jobbflo gör om det till filter och hämtar matchande annonser.',
      knapp: 'Ny sökning →', mål: 'ny' },
    { id: 'bedom', klar: f.bedömda > 0, rubrik: 'Bedöm några annonser',
      text: 'Öppna sökningen och tryck Bedöm → på en annons som ser intressant ut. Du får en checklista: vilka krav du uppfyller, med citat ur annonsen och ditt CV. Det är bedömningen som använder din AI-nyckel.',
      knapp: 'Till sökningen →', mål: 'sok' },
    { id: 'brev', klar: f.brev > 0, rubrik: 'Skriv ditt första brev',
      text: 'På en bedömd annons, tryck Skriv brev →. Be om ändringar i chatten tills brevet låter som du.',
      knapp: 'Till sökningen →', mål: 'sok' },
    { id: 'skicka', klar: f.skickade > 0, rubrik: 'Skicka det',
      text: 'Läs igenom och tryck Skicka nu. Inget skickas innan du gör det. Svaren dyker upp under Inkorg, sorterade som intervju, avslag eller fråga.',
      knapp: 'Till sökningen →', mål: 'sok' },
  ];
}

// Hidden by the user, or not. Browser storage can be off or throw
// (private windows); then the panel simply shows.
function läsDold() {
  try { return window.localStorage.getItem(DOLD) === '1'; } catch { return false; }
}
function sättDold(på) {
  try { window.localStorage.setItem(DOLD, på ? '1' : '0'); } catch { /* shown next time */ }
}

export default function KomIgang({ onProfil, onNySökning, onSök }) {
  const [status, setStatus] = useState(null);
  const [dold, setDold] = useState(true);

  const load = useCallback(() => api('/api/onboarding').then(setStatus).catch(() => {}), []);
  useEffect(() => { setDold(läsDold()); load(); }, [load]);

  if (!status) return null;
  const lista = steg(status);
  const klara = lista.filter((s) => s.klar).length;
  const nästa = lista.find((s) => !s.klar);
  if (!nästa) return null; // everything done: nothing left to guide

  if (dold) {
    return (
      <button className="kig-visa" type="button" onClick={() => { sättDold(false); setDold(false); }}>
        Kom igång-guiden · {klara} av {lista.length} klara — visa
      </button>
    );
  }

  const gå = (mål) => (mål === 'profil' ? onProfil() : mål === 'ny' ? onNySökning() : onSök());

  return (
    <section className="kig" aria-labelledby="kig-rubrik">
      <div className="kig-head">
        <div>
          <span className="kig-eyebrow">Kom igång · {klara} av {lista.length} klara</span>
          <h3 id="kig-rubrik">Från konto till första skickade brev</h3>
        </div>
        <button className="kig-dolj" type="button" onClick={() => { sättDold(true); setDold(true); }}>
          Dölj
        </button>
      </div>
      <div className="kig-bar" aria-hidden="true"><span style={{ width: `${(klara / lista.length) * 100}%` }} /></div>
      <ol className="kig-list">
        {lista.map((s, i) => (
          <li key={s.id} className={`kig-step${s.klar ? ' klar' : ''}${s === nästa ? ' nu' : ''}`}>
            <span className="kig-nr" aria-label={s.klar ? 'klart' : `steg ${i + 1}`}>{s.klar ? '✓' : i + 1}</span>
            <div className="kig-body">
              <b>{s.rubrik}</b>
              {s === nästa && <p>{s.text}</p>}
            </div>
            {s === nästa && (
              <button className="btn primary kig-go" type="button" onClick={() => gå(s.mål)}>{s.knapp}</button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
