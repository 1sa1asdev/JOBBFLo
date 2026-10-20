// The frame for the public documents (/integritet, /villkor): readable
// before signing in, linked from the login page.
export default function Dokument({ rubrik, uppdaterad, children }) {
  return (
    <div className="dash" style={{ maxWidth: 760, margin: '0 auto' }}>
      <a className="llm-link" href="/login">← Jobbflo</a>
      <div className="idx" style={{ marginTop: 14 }}>Senast ändrad {uppdaterad}</div>
      <h2>{rubrik}</h2>
      <div className="dokument">{children}</div>
    </div>
  );
}
