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
export function anslutning(url = process.env.DATABASE_URL) {
  const ca = process.env.DATABASE_CA_CERT?.replace(/\n/g, '\n').trim();
  return {
    connectionString: url,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  };
}

export const poolStorlek = () => Number(process.env.PG_POOL_MAX) || 10;
