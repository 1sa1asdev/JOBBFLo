'use client';
import { useEffect, useRef } from 'react';

// ------------------------------------------------------------
// A modal that behaves like one (WCAG 2.1.2 and 2.4.3): focus moves
// into it when it opens, Tab stays inside it, Escape closes it, and
// focus goes back to whatever opened it when it closes. Without this a
// keyboard user tabbed on behind the overlay, into a page they could
// not see, and a screen reader never learned the dialog had opened.
//
// The first focusable element gets focus, so put the safe choice first
// ("Avbryt" before "Skicka nu").
// ------------------------------------------------------------
const FOKUSBARA = 'a[href],button:not([disabled]),input:not([disabled]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useDialog(ref, open, onClose) {
  const stäng = useRef(onClose);
  stäng.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return undefined;
    const förut = document.activeElement;
    const delar = () => [...dialog.querySelectorAll(FOKUSBARA)];
    (delar()[0] || dialog).focus();

    const tangent = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); stäng.current(); return; }
      if (e.key !== 'Tab') return;
      const d = delar();
      if (!d.length) { e.preventDefault(); return; }
      const först = d[0];
      const sist = d[d.length - 1];
      if (e.shiftKey && (document.activeElement === först || !dialog.contains(document.activeElement))) {
        e.preventDefault(); sist.focus();
      } else if (!e.shiftKey && (document.activeElement === sist || !dialog.contains(document.activeElement))) {
        e.preventDefault(); först.focus();
      }
    };
    document.addEventListener('keydown', tangent);
    return () => {
      document.removeEventListener('keydown', tangent);
      if (förut && document.contains(förut)) förut.focus();
    };
  }, [open, ref]);
}
