import 'dotenv/config';
import pg from 'pg';

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgres://jobbjakt:jobbjakt@localhost:5432/jobbjakt',
  max: 10,
});

// one-liner helper so callers don't need to import the pool for simple reads
export const q = (text, params) => pool.query(text, params);
