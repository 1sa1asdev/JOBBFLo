import 'dotenv/config';
import pg from 'pg';
import { anslutning, poolStorlek } from './dbConfig.js';

export const pool = new pg.Pool({
  ...anslutning(process.env.DATABASE_URL || 'postgres://jobbjakt:jobbjakt@localhost:5432/jobbjakt'),
  max: poolStorlek(),
});

// An idle connection the database drops (a restart, a pooler blocking
// logins) is an 'error' on the pool. Unheard, Node turns it into an
// uncaught exception — the "ohanterat fel" lines of the 22 Oct outage,
// once a second. The pool has already discarded the connection; this
// only says so.
pool.on('error', (err) => console.error('db-pool:', err.message));

// one-liner helper so callers don't need to import the pool for simple reads
export const q = (text, params) => pool.query(text, params);
