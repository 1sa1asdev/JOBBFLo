// npm run db:init   — applies db/schema.sql (drops nothing; fails if tables exist)
// npm run db:seed   — applies db/seed.sql (profile + projects)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const seed = process.argv.includes('--seed');
const file = join(here, '..', 'db', seed ? 'seed.sql' : 'schema.sql');

try {
  const sql = readFileSync(file, 'utf8');
  await pool.query(sql);
  console.log(`✓ applied ${seed ? 'db/seed.sql' : 'db/schema.sql'}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
