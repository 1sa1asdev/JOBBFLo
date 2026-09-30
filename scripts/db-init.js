// npm run db:init   — applies db/schema.sql (drops nothing; fails if tables exist)
// npm run db:seed   — applies db/seed.sql (profile + projects)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const seed = process.argv.includes('--seed');

// db/seed.sql is a placeholder on purpose: it is committed, and a CV is
// personal data. Your real one goes in db/seed.local.sql, which is
// ignored by git and used here when it exists — so seeding gives you
// your own CV without the repo carrying it.
const seedFil = seed && existsSync(join(here, '..', 'db', 'seed.local.sql'))
  ? 'seed.local.sql' : 'seed.sql';
const file = join(here, '..', 'db', seed ? seedFil : 'schema.sql');

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
