'use client';
import { useEffect } from 'react';

// ------------------------------------------------------------
// Keep horizontal rules continuous across the vertical pane
// dividers.
//
// The panes are independent flex columns, so each block sizes to
// its own content. When the stage header wraps to two lines the
// chat header beside it doesn't, and the rule visibly jogs where
// it meets the divider. A CSS min-height sets a floor but cannot
// track wrapping, so the rows are levelled here.
//
// The library header is NOT a simple twin: it spans the chat's
// header AND tools rows, so it's matched against their sum.
//
// Measurement always starts from natural height (inline style
// cleared first), so repeated runs converge instead of ratcheting.
// ------------------------------------------------------------
const H = (el) => Math.ceil(el.getBoundingClientRect().height);
const visible = (el) => el && el.getBoundingClientRect().height > 0;
const q = (s) => document.querySelector(s);

export function useRowAlign(deps = []) {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    let frame = null;
    let observers = [];

    const align = () => {
      const all = ['.chat-header', '.list-header', '.crumb', '.library-header',
        '.chat-tools', '.chat-input', '.profile-link', '.inbox-head', '.tv-head']
        .map(q).filter(Boolean);

      // always measure natural height, never a previous result
      all.forEach((el) => { el.style.minHeight = ''; });

      // panes stack on mobile — nothing to line up
      if (window.matchMedia('(max-width:760px)').matches) return;

      // --- row 1: chat header vs whatever heads the stage ---
      const chatHead = q('.chat-header');
      const stageHead = visible(q('.list-header')) ? q('.list-header') : q('.crumb');
      let headH = 0;
      if (visible(chatHead) && visible(stageHead)) {
        headH = Math.max(H(chatHead), H(stageHead));
        chatHead.style.minHeight = `${headH}px`;
        stageHead.style.minHeight = `${headH}px`;
      }

      // --- row 2: the library header spans chat header + chat tools ---
      const libHead = q('.library-header');
      const tools = q('.chat-tools');
      if (visible(libHead) && visible(tools) && headH) {
        const span = Math.max(H(libHead), headH + H(tools));
        libHead.style.minHeight = `${span}px`;
        tools.style.minHeight = `${span - headH}px`;
      }

      // --- bottom bar ---
      const foot = [q('.chat-input'), q('.profile-link')].filter(visible);
      if (foot.length === 2) {
        const h = Math.max(...foot.map(H));
        foot.forEach((el) => { el.style.minHeight = `${h}px`; });
      }

      // --- inbox is its own two-pane split ---
      const inbox = [q('.inbox-head'), q('.tv-head')].filter(visible);
      if (inbox.length === 2) {
        const h = Math.max(...inbox.map(H));
        inbox.forEach((el) => { el.style.minHeight = `${h}px`; });
      }
    };

    // Coalesce bursts with a timer, NOT requestAnimationFrame:
    // rAF never fires in a hidden tab, which would strand stale
    // heights (including forcing desktop heights onto a phone).
    const schedule = () => {
      clearTimeout(frame);
      frame = setTimeout(align, 50);
    };

    align();                       // run now, synchronously
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', align);

    // Observe the CONTENT inside each block, not the block itself:
    // the block's height is what we set, so observing it would
    // retrigger on our own output and loop.
    observers = ['.list-header', '.chat-header', '.chat-tools', '.inbox-head', '.tv-head']
      .map(q).filter(Boolean)
      .flatMap((el) => [...el.children])
      .map((child) => { const ro = new ResizeObserver(schedule); ro.observe(child); return ro; });

    return () => {
      clearTimeout(frame);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', align);
      observers.forEach((ro) => ro.disconnect());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
