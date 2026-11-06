'use client';
import { createContext, useContext, useEffect, useRef } from 'react';
import { api } from './api.js';
import { planera, versionFör } from './beaconPlan.js';

// ------------------------------------------------------------
// One change beacon for the whole screen.
//
// Each view used to poll /api/pulse on its own: the top bar every 5 s,
// the inbox and the result list every 3 s, each asking the same global
// question — and Auto-ansökan, the address finder and Översikt fetched
// their whole payload on a timer with no beacon at all. Measured on an
// idle tab: 32 requests a minute in the inbox and the search view, and
// in Auto-ansökan a 1.2 s campaign fetch seven times a minute.
//
// Now one loop asks once, for every area a mounted view subscribes to
// (app/api/pulse/route.js), and tells each view when ITS version moved:
//
//   useBeacon('global', fn)                       inbox, applications
//   useBeacon('search', fn, { param: searchId })  one search's list
//   useBeacon('kampanjer', fn)                    the campaign cards
//   useBeacon('adresser', fn, { param: searchId }) the address finder
//
// `interval` is how fresh a view needs its area: the loop runs at the
// fastest anyone asks for, and an area slower than that is only asked
// for when it is due. `minGap` is the least time between two calls to
// a view whose rebuild is expensive (the campaign cards: 8 s, the old
// timer's pace), so a busy campaign can never cost more than before.
// Like usePoll it stops while the tab is hidden,
// runs at once when the tab comes back, and never has two in flight.
// A view whose handler is still running (a slow load) is not called
// again on top of itself; it gets one more call when it finishes, if
// its version moved meanwhile.
// ------------------------------------------------------------
const Beacon = createContext(null);

export function BeaconProvider({ children }) {
  const subs = useRef(new Map());
  const motor = useRef(null);

  if (!motor.current) {
    let timer = null;
    let igång = false;
    let stoppad = true;

    const intervall = () => {
      let min = 5000;
      for (const s of subs.current.values()) min = Math.min(min, s.interval);
      return min;
    };

    // Call a view with its latest version — unless its previous call is
    // still running; then once more when that finishes, if the version
    // moved again in between.
    //
    // And never more often than its minGap. While a campaign runs, its
    // hash moves every round; without a floor the campaign cards (a
    // second or more each) would rebuild every 5 s — more than the 8 s
    // timer this replaced, at the busiest moment. A change inside the
    // gap is not dropped: one call follows when the gap has passed.
    const ropa = (s, first) => {
      if (s.kör) { s.igen = true; return; }
      const kvar = (s.minGap || 0) - (Date.now() - (s.körd || 0));
      if (kvar > 0) {
        if (!s.väntar) {
          s.väntar = setTimeout(() => { s.väntar = null; if (s.senast !== s.kallad) ropa(s, false); }, kvar);
        }
        return;
      }
      const v = s.senast;
      s.kallad = v;
      s.körd = Date.now();
      s.kör = Promise.resolve()
        .then(() => s.fn.current(v, { first }))
        .catch(() => { /* the view's own error handling shows it */ })
        .finally(() => {
          s.kör = null;
          if (s.igen) { s.igen = false; if (s.senast !== s.kallad) ropa(s, false); }
        });
    };

    const varv = async () => {
      if (stoppad || igång || document.hidden || !subs.current.size) return;
      igång = true;
      try {
        const nu = Date.now();
        // global is always asked; another area only when it is due
        const frågade = [...subs.current.values()]
          .filter((s) => s.del === 'global' || !s.frågad || nu - s.frågad >= s.interval - 250);
        const { frågor, svarIndex } = planera(frågade);
        const svar = await Promise.all(frågor.map((f) => api(`/api/pulse${f ? `?${f}` : ''}`)));
        for (const s of frågade) {
          s.frågad = nu;
          const v = versionFör(s, svar, svarIndex);
          s.onTick?.current?.();
          if (v === s.senast) continue;
          const first = s.senast === undefined;
          s.senast = v;
          ropa(s, first);
        }
      } catch {
        // transient (server restart, offline) — the next round retries
      } finally {
        igång = false;
      }
    };

    const schemalägg = (direkt = false) => {
      clearTimeout(timer);
      if (stoppad) return;
      timer = setTimeout(async () => { await varv(); schemalägg(); }, direkt ? 0 : intervall());
    };
    const väck = () => { if (!document.hidden) schemalägg(true); };

    motor.current = {
      start() {
        stoppad = false;
        document.addEventListener('visibilitychange', väck);
        window.addEventListener('focus', väck);
        schemalägg();
      },
      stopp() {
        stoppad = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', väck);
        window.removeEventListener('focus', väck);
      },
      // a new or changed subscription is asked about on the next tick,
      // not a whole interval later
      prenumerera(id, s) { subs.current.set(id, s); schemalägg(true); },
      avsluta(id) {
        clearTimeout(subs.current.get(id)?.väntar);
        subs.current.delete(id);
      },
    };
  }

  useEffect(() => { motor.current.start(); return () => motor.current.stopp(); }, []);
  return <Beacon.Provider value={motor.current}>{children}</Beacon.Provider>;
}

let nästaId = 0;

export function useBeacon(del, fn, { param = null, interval = 5000, minGap = 0, enabled = true, onTick } = {}) {
  const motor = useContext(Beacon);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const tickRef = useRef(onTick);
  tickRef.current = onTick;
  const id = useRef(null);
  if (id.current === null) id.current = `b${nästaId++}`;

  useEffect(() => {
    if (!motor || !enabled || ((del === 'search' || del === 'adresser') && !param)) return undefined;
    // a new param (another search) starts from no version: its first
    // answer is a "first", not a change
    motor.prenumerera(id.current, { del, param, interval, minGap, fn: fnRef, onTick: tickRef, senast: undefined, frågad: 0 });
    return () => motor.avsluta(id.current);
  }, [motor, del, param, interval, minGap, enabled]);
}
