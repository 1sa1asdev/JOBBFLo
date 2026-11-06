'use client';

// ------------------------------------------------------------
// The paperclip: one button for attachments wherever there are some —
// the campaign letter's header (CampaignLetter.jsx) and the reply box in
// the inbox (Inbox.jsx). The count says how many files go along; a red
// "!" says one that should is missing (a campaign letter without a CV).
// The menu it opens is the caller's, named by `controls`.
// ------------------------------------------------------------
export default function Gem({ open, onToggle, antal = 0, saknas = false, controls, label, iFält = false }) {
  return (
    <button type="button" className={`gem${saknas ? ' saknas' : ''}${iFält ? ' i-falt' : ''}`}
      aria-expanded={open} aria-controls={controls}
      aria-label={saknas ? `${label} — saknas` : `${label} (${antal})`}
      onClick={onToggle}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {!iFält && <span className="gem-text" aria-hidden="true">{label}</span>}
      {saknas ? <span className="gem-antal" aria-hidden="true">!</span>
        : antal > 0 && <span className="gem-antal" aria-hidden="true">{antal}</span>}
    </button>
  );
}
