// ------------------------------------------------------------
// How every process connects to Postgres: the app, the worker, the
// janitor, and the migration and schema scripts the deploy runs.
//
// TLS: Supabase signs its server certificates with its own CA, so a
// plain sslmode=require either fails verification or is told to skip
// it. DATABASE_CA_CERT holds that CA (Supabase → Database → Settings →
// SSL Configuration → download), and the connection then verifies the
// server properly. Leave sslmode out of the URL when it is set.
//
// Pool size: a Vercel function is one of many instances, each with its
// own pool, against a pooler with a few dozen slots. PG_POOL_MAX keeps
// each one small there; the worker can use the default.
// ------------------------------------------------------------
//
// Without the certificate a Supabase host still gets TLS — encrypted,
// just not verified — and says so once. pg never tries TLS on its own,
// the pooler accepts a plain connection when "Enforce SSL" is off, and
// that is how the deploy workflow's migrations ran before it was given
// the certificate: unencrypted, database password and all.
//
// A certificate pasted as one line (literal "\n") is turned back into PEM.
let sagtOmCa = false;
export function anslutning(url = process.env.DATABASE_URL) {
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n').trim();
  if (ca) return { connectionString: url, ssl: { ca, rejectUnauthorized: true } };
  const värd = String(url || '').split('@').pop() || '';
  if (!/\.supabase\.(com|co)(:|\/|$)/.test(värd)) return { connectionString: url };
  if (!sagtOmCa) {
    sagtOmCa = true;
    console.warn('db: DATABASE_CA_CERT saknas — krypterar mot Supabase men verifierar inte servern');
  }
  return { connectionString: url, ssl: { rejectUnauthorized: false } };
}

export const poolStorlek = () => Number(process.env.PG_POOL_MAX) || 10;
