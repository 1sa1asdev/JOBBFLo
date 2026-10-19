// ------------------------------------------------------------
// The one way the schema changes.
//
//   npm run db:migrate                 bring this database up to date
//   npm run db:migrate -- --status     what is applied, what is pending
//   npm run db:migrate -- --dry-run    list what would run, run nothing
//   npm run db:migrate -- --adopt      record an existing database that
//                                      was migrated by hand (see below)
//   --url <connection string>          another database than DATABASE_URL
//
// Before this, migrations were pasted into psql by hand and nothing
// recorded which ones a database had. That worked for one machine and
// stops working the moment there are two — a staging database, a CI
// database, production — because "did 041 run here?" has no answer.
// Now every database carries schema_migrations, and this script is the
// only thing that writes to it.
//
// A database starts in one of three states:
//
//   empty          db/baseline.sql is applied (the schema as of the
//                  version on its `baseline-covers:` line), and every
//                  migration up to that version is recorded as covered.
//   tracked        has schema_migrations; only what is missing runs.
//   untracked      has tables but no record — a database migrated by
//                  hand. Refused unless --adopt, because guessing which
//                  migrations it has is exactly the problem this solves.
//                  Run `npm run db:check -- --live` first: it proves the
//                  database matches the baseline before you vouch for it.
//
// Each migration runs in its own transaction on its own connection, so
// a failure leaves nothing half-applied and no session setting leaks
// into the next file. A file can opt out of the transaction with a
// `-- migrate:no-transaction` line, for the few statements Postgres
// refuses to run inside one (CREATE INDEX CONCURRENTLY).
// ------------------------------------------------------------
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const MIGRATIONS = join(DB_DIR, 'migrations');
const BASELINE = join(DB_DIR, 'baseline.sql');

// Two deploys starting at once — the web app and the worker — must not
// both migrate. Anyone else waits here.
const LOCK_KEY = 8123480;

// Line endings are normalised before hashing: git checks files out as
// CRLF on Windows and LF on Linux, and the same migration must not look
// edited just because CI read it on another operating system.
const läs = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const kontrollsumma = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^\d{3,}_.+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const text = läs(join(MIGRATIONS, file));
      return {
        version: file.match(/^(\d+)_/)[1],
        name: file.replace(/^\d+_/, '').replace(/\.sql$/, ''),
        file,
        text,
        checksum: kontrollsumma(text),
        transactional: !/^\s*--\s*migrate:no-transaction\s*$/m.test(text),
      };
    });
}

export function baselineVersion() {
  const m = läs(BASELINE).match(/baseline-covers:\s*(\d+)/);
  if (!m) throw new Error('db/baseline.sql saknar raden "baseline-covers: NNN"');
  return m[1];
}

function args(argv) {
  const a = { status: false, dryRun: false, adopt: false, url: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--status') a.status = true;
    else if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--adopt') a.adopt = true;
    else if (argv[i] === '--quiet') a.quiet = true;
    else if (argv[i] === '--url') a.url = argv[++i];
    else throw new Error(`okänt argument: ${argv[i]}`);
  }
  return a;
}

async function connect(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  // Notices from IF NOT EXISTS and friends are noise on every run.
  await client.query('SET client_min_messages = warning');
  return client;
}

// Runs one file on a fresh connection that is thrown away afterwards —
// pg_dump output and some migrations change session state.
async function kör(url, sql, { transactional = true } = {}) {
  const c = await connect(url);
  try {
    if (!transactional) { await c.query(sql); return; }
    await c.query('BEGIN');
    try {
      await c.query(sql);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await c.end();
  }
}

export async function migrate({
  url = process.env.DATABASE_URL, dryRun = false, adopt = false, status = false, quiet = false,
} = {}) {
  if (!url) throw new Error('DATABASE_URL saknas (eller ange --url)');
  const log = quiet ? () => {} : (...m) => console.log(...m);
  const filer = migrationFiles();
  const täcker = baselineVersion();

  const c = await connect(url);
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const { rows: [{ finns }] } = await c.query(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS finns`);
    const { rows: [{ tabeller }] } = await c.query(
      `SELECT count(*)::int AS tabeller FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`);

    let tillstånd = finns ? 'tracked' : tabeller === 0 ? 'empty' : 'untracked';
    if (status) log(`databas: ${tillstånd} (${tabeller} tabeller), baslinjen täcker ${täcker}`);

    if (tillstånd === 'untracked' && !adopt) {
      throw new Error(
        `Databasen har ${tabeller} tabeller men ingen schema_migrations — den är migrerad för hand.\n`
        + `  Kör \`npm run db:check -- --live\` för att se att den stämmer med baslinjen,\n`
        + `  och sedan \`npm run db:migrate -- --adopt\` för att registrera den.`);
    }

    const skapaTabell = `CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      via        text NOT NULL CHECK (via IN ('migration', 'baseline', 'adopted')),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const täckta = filer.filter((f) => Number(f.version) <= Number(täcker));
    const registrera = async (via) => {
      await c.query(skapaTabell);
      for (const f of täckta) {
        await c.query(
          `INSERT INTO public.schema_migrations (version, name, checksum, via)
           VALUES ($1, $2, $3, $4) ON CONFLICT (version) DO NOTHING`,
          [f.version, f.name, f.checksum, via]);
      }
    };

    if (tillstånd === 'empty' && !status) {
      if (dryRun) {
        log(`skulle köra db/baseline.sql (täcker ${täckta.length} migrationer, t.o.m. ${täcker})`);
      } else {
        log(`→ baslinje (t.o.m. ${täcker})`);
        await kör(url, läs(BASELINE));
        await registrera('baseline');
        tillstånd = 'tracked';
      }
    } else if (tillstånd === 'untracked' && adopt && !status) {
      if (dryRun) {
        log(`skulle registrera ${täckta.length} migrationer (t.o.m. ${täcker}) som redan gjorda`);
      } else {
        await registrera('adopted');
        log(`✓ registrerade ${täckta.length} migrationer (t.o.m. ${täcker}) som redan gjorda för hand`);
        tillstånd = 'tracked';
      }
    }

    const { rows: gjorda } = tillstånd === 'tracked'
      ? await c.query(`SELECT version, checksum, via FROM public.schema_migrations`)
      : { rows: [] };
    const gjord = new Map(gjorda.map((r) => [r.version, r]));

    // A migration edited after it ran is a migration some databases
    // have in one shape and others in another. Fix forward with a new
    // file instead; this refuses rather than letting the two drift.
    const ändrade = filer.filter((f) => gjord.has(f.version) && gjord.get(f.version).checksum !== f.checksum);
    if (ändrade.length) {
      throw new Error(`Redan körda migrationer har ändrats i efterhand: ${ändrade.map((f) => f.file).join(', ')}\n`
        + '  Ändra aldrig en körd migration — skriv en ny som rättar den.');
    }

    const väntande = filer.filter((f) => !gjord.has(f.version) && Number(f.version) > Number(täcker));
    if (status) {
      log(`gjorda: ${gjord.size}  väntande: ${väntande.length}`);
      for (const f of väntande) log(`  väntar: ${f.file}`);
      return { state: tillstånd, applied: gjord.size, pending: väntande.map((f) => f.file) };
    }

    if (!väntande.length) {
      log(dryRun ? 'inget att köra' : '✓ databasen är aktuell');
      return { state: tillstånd, ran: [] };
    }
    const körda = [];
    for (const f of väntande) {
      if (dryRun) { log(`skulle köra: ${f.file}`); continue; }
      log(`→ ${f.file}`);
      try {
        await kör(url, f.text, { transactional: f.transactional });
      } catch (err) {
        throw new Error(`${f.file} misslyckades: ${err.message}`);
      }
      await c.query(
        `INSERT INTO public.schema_migrations (version, name, checksum, via)
         VALUES ($1, $2, $3, 'migration')`, [f.version, f.name, f.checksum]);
      körda.push(f.file);
    }
    if (!dryRun) log(`✓ ${körda.length} migration${körda.length === 1 ? ' körd' : 'er körda'}`);
    return { state: tillstånd, ran: körda };
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await c.end();
  }
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const a = args(process.argv.slice(2));
    await migrate({ ...a, url: a.url || process.env.DATABASE_URL });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
}
