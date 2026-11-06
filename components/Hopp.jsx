'use client';

// ------------------------------------------------------------
// Jump buttons: one row under the overview tabs that takes the reader
// straight to a section — on a phone the page is long, and scrolling
// past five blocks to reach the sixth is the problem this solves.
//
// Each target is an element id; `före` runs first (to open a folded
// section or pick a list) and the jump waits a frame for it to render.
// Focus moves to the section, so keyboard and screen-reader users land
// where the eye does.
// ------------------------------------------------------------
export default function Hopp({ mål, etikett }) {
  const gå = (m) => {
    m.före?.();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.getElementById(m.id);
      if (!el) return;
      const lugnt = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: lugnt ? 'auto' : 'smooth', block: 'start' });
      el.focus({ preventScroll: true });
    }));
  };
  return (
    <nav className="hopp" aria-label={etikett}>
      {mål.filter(Boolean).map((m) => (
        <button type="button" key={m.id + m.label} onClick={() => gå(m)}>{m.label}</button>
      ))}
    </nav>
  );
}
