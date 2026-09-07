'use client';
import { useEffect, useState } from 'react';

// Small "live" indicator: green when connected and polling, and it
// flashes when an update actually lands, so something arriving while
// you're looking at the screen is visibly new rather than silently
// swapped in.
//
// Lives on its own because more than one view polls now. Pass the
// timestamp of the last real change — not of the last poll, or the dot
// says "uppdaterat" every few seconds and stops meaning anything.
export default function LiveDot({ pulsed, checked }) {
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    if (!pulsed) return undefined;
    setRecent(true);
    const t = setTimeout(() => setRecent(false), 2500);
    return () => clearTimeout(t);
  }, [pulsed]);

  // The flash lasts 2.5s, so anyone not looking at that moment sees a
  // dot that says "Live" whether the poll is running or died twenty
  // minutes ago. The clock is the part that can be checked: if it is
  // not within the last few seconds, the view is not live, and now you
  // can tell without asking.
  const klocka = checked
    ? new Date(checked).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <span
      className={`live-dot${recent ? ' hit' : ''}`}
      title={klocka ? `Senast hämtad ${klocka}` : 'Live — uppdateras automatiskt'}
    >
      <i />{recent ? 'Uppdaterat' : 'Live'}
      {klocka && <em className="live-at">{klocka}</em>}
    </span>
  );
}
