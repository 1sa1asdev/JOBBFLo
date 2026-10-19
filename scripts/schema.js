// ------------------------------------------------------------
// The schema file, generated — and the check that keeps it honest.
//
//   npm run db:schema               regenerate db/schema.sql
//   npm run db:check                db/schema.sql == baseline + migrations
//   npm run db:check -- --live      DATABASE_URL  == baseline + migrations
//
// db/schema.sql was hand-written and said "read this first", and by the
// time anyone checked it was 7 tables, 27 indexes and ~130 columns
// behind the real database. A document that has to be kept in step by
// hand will not be. So it is now a snapshot: build an empty database
// with the migrations, dump it, write the file. db:check is what CI
// runs — a migration merged without regenerating the snapshot fails the
// build instead of quietly making the file wrong again.
//
// --live answers the other question: has someone changed this database
// by hand? It is the check to run before `db:migrate -- --adopt`, and
// on any database you are about to trust.
//
// Both build throwaway databases on the same server as DATABASE_URL
// (the role needs CREATEDB) and drop them afterwards.
// ------------------------------------------------------------
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate, baselineVersion, migrationFiles } from './migrate.js';

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql');

const medDatabas = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

async function admin(url, sql) {
  const c = new pg.Client({ connectionString: medDatabas(url, 'postgres') });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

// A throwaway database, dropped again whatever happens inside.
async function tillfällig(url, namn, fn) {
  const db = `jobbflo_${namn}_${process.pid}`;
  await admin(url, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin(url, `CREATE DATABASE ${db}`);
  try {
    return await fn(medDatabas(url, db), db);
  } finally {
    await admin(url, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
  }
}

// Everything that makes two schemas behave differently, one line each,
// sorted — so column order and creation order do not count, and
// anything else does. Extension-owned functions are left out: they
// belong to pgvector and pgcrypto, not to us.
const AVTRYCK = `
SELECT 'extension ' || extname FROM pg_extension WHERE extname <> 'plpgsql'
UNION ALL
SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
  || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
  || COALESCE(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
  || CASE WHEN a.attgenerated <> '' THEN ' generated' ELSE '' END
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
  AND a.attnum > 0 AND NOT a.attisdropped AND c.relname <> 'schema_migrations'
UNION ALL
SELECT 'constraint ' || t.relname || ' ' || co.conname || ' ' || pg_get_constraintdef(co.oid)
FROM pg_constraint co
JOIN pg_class t ON t.oid = co.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname <> 'schema_migrations'
UNION ALL
SELECT 'index ' || pg_get_indexdef(i.indexrelid)
FROM pg_index i
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname <> 'schema_migrations'
UNION ALL
SELECT 'view ' || c.relname || ' ' || md5(pg_get_viewdef(c.oid))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
UNION ALL
SELECT 'trigger ' || pg_get_triggerdef(t.oid)
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
UNION ALL
SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = p.oid AND dep.deptype = 'e')
UNION ALL
SELECT 'comment ' || c.relname || COALESCE('.' || a.attname, '') || ' ' || md5(d.description)
FROM pg_description d
JOIN pg_class c ON c.oid = d.objoid AND d.classoid = 'pg_class'::regclass
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid AND d.objsubid > 0
WHERE n.nspname = 'public'
ORDER BY 1`;

async function avtryck(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query(AVTRYCK);
    return rows.map((r) => Object.values(r)[0]);
  } finally { await c.end(); }
}

async function körFil(url, sql) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('SET client_min_messages = warning');
    await c.query(sql);
  } finally { await c.end(); }
}

function jämför(a, b, namnA, namnB) {
  const B = new Set(b);
  const A = new Set(a);
  const baraA = a.filter((x) => !B.has(x));
  const baraB = b.filter((x) => !A.has(x));
  return { lika: !baraA.length && !baraB.length, baraA, baraB, namnA, namnB };
}

function skrivSkillnad({ baraA, baraB, namnA, namnB }) {
  const visa = (lista, namn) => {
    if (!lista.length) return;
    console.log(`\n  bara i ${namn} (${lista.length}):`);
    for (const x of lista.slice(0, 40)) console.log(`    ${x}`);
    if (lista.length > 40) console.log(`    … och ${lista.length - 40} till`);
  };
  visa(baraA, namnA);
  visa(baraB, namnB);
}

// ------------------------------------------------------------
// pg_dump: the local binary if there is one, otherwise the one inside
// the dev database container — Windows machines usually have Docker
// and not the Postgres client tools.
// ------------------------------------------------------------
function pgDump(url, db) {
  const flaggor = ['--schema-only', '--no-owner', '--no-privileges'];
  const lokal = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (lokal.status === 0) {
    const r = spawnSync('pg_dump', [...flaggor, medDatabas(url, db)], { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`pg_dump: ${r.stderr}`);
    return r.stdout;
  }
  const behållare = process.env.PG_DOCKER_CONTAINER || 'jobbjakt-pg';
  const användare = decodeURIComponent(new URL(url).username) || 'postgres';
  const r = spawnSync('docker', ['exec', behållare, 'pg_dump', ...flaggor, '-U', användare, '-d', db],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) {
    throw new Error(`varken pg_dump eller docker-behållaren ${behållare} fungerade: ${r.stderr || r.error?.message}\n`
      + '  Installera Postgres klientverktyg, eller sätt PG_DOCKER_CONTAINER.');
  }
  return r.stdout;
}

// Session settings, psql meta-commands and the dump's own banner are
// noise in a file meant for reading; COMMENT ON EXTENSION needs the
// extension's owner, which a hosted database will not let us be.
function städa(dump) {
  return dump.replace(/\r\n/g, '\n').split('\n')
    .filter((l) => !/^SET |^SELECT pg_catalog\.set_config|^\\|^COMMENT ON EXTENSION|^-- Dumped (by|from)/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function snapshot(url = process.env.DATABASE_URL) {
  const filer = migrationFiles();
  const senaste = filer.at(-1)?.version;
  const text = await tillfällig(url, 'snapshot', async (tmpUrl, db) => {
    await migrate({ url: tmpUrl, quiet: true });
    return pgDump(url, db);
  });
  const huvud = [
    '-- ============================================================',
    '-- JOBBFLO — the schema, as the migrations build it.',
    '--',
    '-- GENERATED by `npm run db:schema`. Do not edit: change the schema',
    '-- with a new file in db/migrations/, then regenerate this. CI',
    '-- (`npm run db:check`) fails when the two disagree.',
    '--',
    '-- Read it to understand the data model — the COMMENT ON lines carry',
    '-- the reasons. Do not run it to create a database: `npm run db:init`',
    '-- does that, through the same path production uses, and also adds',
    '-- the reference rows the worker needs.',
    '--',
    `-- Baseline covers migrations up to ${baselineVersion()}; latest migration ${senaste}.`,
    '-- ============================================================',
    '',
  ].join('\n');
  writeFileSync(SCHEMA, `${huvud}\n${städa(text)}\n`);
  return SCHEMA;
}

export async function check({ url = process.env.DATABASE_URL, live = false } = {}) {
  return tillfällig(url, 'migrerad', async (migreradUrl) => {
    await migrate({ url: migreradUrl, quiet: true });
    const facit = await avtryck(migreradUrl);

    if (live) {
      return jämför(await avtryck(url), facit, 'den här databasen', 'baslinje + migrationer');
    }
    return tillfällig(url, 'schemafil', async (filUrl) => {
      await körFil(filUrl, readFileSync(SCHEMA, 'utf8'));
      return jämför(await avtryck(filUrl), facit, 'db/schema.sql', 'baslinje + migrationer');
    });
  });
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [kommando, ...rest] = process.argv.slice(2);
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL saknas');
    if (kommando === 'snapshot') {
      const fil = await snapshot();
      console.log(`✓ skrev ${fil}`);
    } else if (kommando === 'check') {
      const live = rest.includes('--live');
      const r = await check({ live });
      if (r.lika) {
        console.log(`✓ ${r.namnA} stämmer med ${r.namnB}`);
      } else {
        console.log(`✗ ${r.namnA} skiljer sig från ${r.namnB}:`);
        skrivSkillnad(r);
        console.log(live
          ? '\n  Databasen är ändrad för hand, eller saknar migrationer.'
          : '\n  Kör `npm run db:schema` och committa db/schema.sql.');
        process.exitCode = 1;
      }
    } else {
      throw new Error('användning: node scripts/schema.js snapshot | check [--live]');
    }
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
}
