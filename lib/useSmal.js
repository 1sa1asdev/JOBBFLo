'use client';
import { useEffect, useState } from 'react';

// True on a phone-sized screen: the same 760px line the stylesheet draws
// (app/globals.css). For what CSS cannot do alone, like not mounting a
// second copy of a component on a screen where it would stay hidden.
export function useSmal(px = 760) {
  const [smal, setSmal] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(`(max-width:${px}px)`);
    const följ = () => setSmal(m.matches);
    följ();
    m.addEventListener('change', följ);
    return () => m.removeEventListener('change', följ);
  }, [px]);
  return smal;
}
