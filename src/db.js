import 'dotenv/config';
import pg from 'pg';
import { anslutning, poolStorlek } from './dbConfig.js';

export const pool = new pg.Pool({
  ...anslutning(process.env.DATABASE_URL || 'postgres://jobbjakt:jobbjakt@localhost:5432/jobbjakt'),
  max: poolStorlek(),
});

// one-liner helper so callers don't need to import the pool for simple reads
export const q = (text, params) => pool.query(text, params);
