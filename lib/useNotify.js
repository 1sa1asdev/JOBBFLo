'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

// ------------------------------------------------------------
// Desktop notifications for employer replies.
//
// The point of this app is that a reply reaches you fast — the
// IMAP loop classifies within ~30s, but that is wasted if the tab
// is in the background. Browsers only allow notifications after an
// explicit click, so permission is requested from a button, never
// on load.
//
// Deliberately quiet: only INBOUND messages notify. Applications
// you send, scores, and drafts do not.
// ------------------------------------------------------------
const STORAGE_KEY = 'jobbflo.notify';

export function useNotify() {
  const [permission, setPermission] = useState('default');
  const [enabled, setEnabled] = useState(false);
  const seen = useRef(new Set());
  const primed = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    setPermission(Notification.permission);
    setEnabled(window.localStorage.getItem(STORAGE_KEY) === '1'
      && Notification.permission === 'granted');
  }, []);

  const request = useCallback(async () => {
    if (!('Notification' in window)) return 'unsupported';
    const p = await Notification.requestPermission();
    setPermission(p);
    const on = p === 'granted';
    setEnabled(on);
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    if (on) new Notification('Jobbflo', { body: 'Notiser på — du får en pling när en arbetsgivare svarar.' });
    return p;
  }, []);

  const toggle = useCallback(async () => {
    if (enabled) {
      setEnabled(false);
      window.localStorage.setItem(STORAGE_KEY, '0');
      return;
    }
    if (Notification.permission === 'granted') {
      setEnabled(true);
      window.localStorage.setItem(STORAGE_KEY, '1');
      return;
    }
    await request();
  }, [enabled, request]);

  // Feed it the current thread list; it notifies about inbound
  // messages it has not seen before. The first call only records
  // what already exists, so opening the app never fires a burst.
  const notifyFrom = useCallback((threads) => {
    if (!Array.isArray(threads)) return;
    const inbound = threads.filter((t) => t.last_direction === 'inbound' && t.last_msg_at);
    if (!primed.current) {
      inbound.forEach((t) => seen.current.add(`${t.id}:${t.last_msg_at}`));
      primed.current = true;
      return;
    }
    for (const t of inbound) {
      const key = `${t.id}:${t.last_msg_at}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      if (!enabled || Notification.permission !== 'granted') continue;

      const label = t.status === 'interview' ? 'Intervjuförfrågan'
        : t.status === 'rejected' ? 'Avslag' : 'Svar';
      const n = new Notification(`${label} — ${t.employer}`, {
        body: `${t.title}\n${(t.last_preview || '').slice(0, 90)}`,
        tag: t.id,                    // one notification per thread
        icon: '/favicon.ico',
      });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }, [enabled]);

  return { enabled, permission, toggle, notifyFrom };
}
