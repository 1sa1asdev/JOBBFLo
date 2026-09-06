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
export default function LiveDot({ pulsed }) {
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    if (!pulsed) return undefined;
    setRecent(true);
    const t = setTimeout(() => setRecent(false), 2500);
    return () => clearTimeout(t);
  }, [pulsed]);
  return (
    <span
      className={`live-dot${recent ? ' hit' : ''}`}
      title={recent ? 'Ny uppdatering' : 'Live — uppdateras automatiskt'}
    >
      <i />{recent ? 'Uppdaterat' : 'Live'}
    </span>
  );
}
