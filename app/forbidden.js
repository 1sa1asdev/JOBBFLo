// What a blocked account sees instead of the app (src/auth.js).
export default function Spärrad() {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-head">
          <span className="brand-line">Jobbflo</span>
          <h1>Kontot är spärrat</h1>
        </div>
        <p className="login-hint" style={{ marginTop: 0 }}>
          Administratören har spärrat kontot. Inga kampanjer körs och ingen post läses medan
          spärren gäller. Hör av dig till administratören om du tror att det är fel.
        </p>
      </div>
    </div>
  );
}
