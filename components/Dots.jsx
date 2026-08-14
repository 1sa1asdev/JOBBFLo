'use client';

// Three dots that bounce one at a time — the app's single waiting
// animation. Inherits currentColor so it reads correctly whether it
// sits in a --mute loading note or an --ink chat line.
//
// Deliberately not a spinner: a spinner implies a bounded task with
// a duration, and most waits here are an LLM call of unknown length.
export default function Dots({ label = 'Laddar' }) {
  return (
    <span className="dots" role="status" aria-label={label}>
      <i /><i /><i />
    </span>
  );
}
