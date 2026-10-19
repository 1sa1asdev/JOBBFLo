// npm run db:seed — fills a migrated database with a profile and projects.
//
// The schema is not this file's job any more: `npm run db:init` runs
// scripts/migrate.js, which builds it from db/baseline.sql and
// db/migrations/ and records what it did. This used to apply
// db/schema.sql directly, which had fallen far behind the migrations.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));

// db/seed.sql is a placeholder on purpose: it is committed, and a CV is
// personal data. Your real one goes in db/seed.local.sql, which is
// ignored by git and used here when it exists — so seeding gives you
// your own CV without the repo carrying it.
const seedFil = existsSync(join(here, '..', 'db', 'seed.local.sql')) ? 'seed.local.sql' : 'seed.sql';

try {
  await pool.query(readFileSync(join(here, '..', 'db', seedFil), 'utf8'));
  console.log(`✓ applied db/${seedFil}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
