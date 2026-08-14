'use client';
import { useEffect, useRef } from 'react';

// ------------------------------------------------------------
// Polling that behaves. The worker writes to Postgres and the UI
// reads — CLAUDE.md rules out pushing from worker to browser, so
// polling is the channel. That makes *how* we poll matter:
//
//  - stops entirely while the tab is hidden (no burning quota or
//    battery on a background tab)
//  - fires immediately on focus/visibility, so coming back to the
//    tab shows current state at once rather than after a delay
//  - skips a tick if the previous one is still in flight
// ------------------------------------------------------------
export function usePoll(fn, { interval = 4000, enabled = true } = {}) {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!enabled) return undefined;

    let timer = null;
    let stopped = false;
    let inFlight = false;

    const run = async () => {
      if (stopped || inFlight || document.hidden) return;
      inFlight = true;
      try {
        await saved.current();
      } catch {
        // transient (server restart, offline) — next tick retries
      } finally {
        inFlight = false;
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      if (stopped) return;
      timer = setTimeout(async () => {
        await run();
        schedule();
      }, interval);
    };

    const wake = () => {
      if (document.hidden || stopped) return;
      run().then(schedule);
    };

    schedule();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [interval, enabled]);
}
