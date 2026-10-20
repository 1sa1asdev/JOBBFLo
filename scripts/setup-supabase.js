// Sets up a hosted Supabase project for Jobbflo, from .env.supabase.
//
//   node scripts/setup-supabase.js staging
//       an empty project: the schema from the migrations, then the checks
//
//   node scripts/setup-supabase.js production --flytta
//       your local data moved in: a fresh dump of the local database,
//       restored into the (empty) production project, then the checks
//
//   node scripts/setup-supabase.js <miljö> --kontrollera
//       only the checks
//
//   --fil <sökväg>  another settings file than .env.supabase (a rehearsal
//                   against the local Supabase stack, say)
//
// The checks are the deploy workflow's: the database matches the
// migrations, the Data API is locked, and the public key reads nothing.
//
// Secrets are read from .env.supabase (gitignored) and never printed:
// hosts are shown, passwords and keys are not.
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const ROT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [miljö, ...flaggor] = process.argv.slice(2);
if (!['staging', 'production'].includes(miljö)) {
  console.error('användning: node scripts/setup-supabase.js staging|production [--flytta|--kontrollera]');
  process.exit(1);
}
const flytta = flaggor.includes('--flytta');
const baraKontroll = flaggor.includes('--kontrollera');

const filIndex = flaggor.indexOf('--fil');
const filen = filIndex >= 0 ? resolve(flaggor[filIndex + 1] || '') : join(ROT, '.env.supabase');
if (!existsSync(filen)) { console.error(`${filen} saknas`); process.exit(1); }
const env = dotenv.parse(readFileSync(filen));
const P = miljö === 'staging' ? 'STAGING' : 'PROD';
const url = env[`${P}_DATABASE_URL`]?.trim();
const supabaseUrl = env[`${P}_SUPABASE_URL`]?.trim();
const anon = env[`${P}_SUPABASE_ANON_KEY`]?.trim();
const caFil = env[`${P}_CA_FIL`]?.trim() && resolve(ROT, env[`${P}_CA_FIL`].trim());

const saknas = [
  !url && `${P}_DATABASE_URL`, !supabaseUrl && `${P}_SUPABASE_URL`, !anon && `${P}_SUPABASE_ANON_KEY`,
].filter(Boolean);
if (saknas.length) { console.error(`fyll i ${saknas.join(', ')} i .env.supabase`); process.exit(1); }
if (/\[YOUR-PASSWORD\]/i.test(url)) { console.error(`${P}_DATABASE_URL innehåller fortfarande [YOUR-PASSWORD]`); process.exit(1); }
if (/:6543\//.test(url)) {
  console.error(`${P}_DATABASE_URL pekar på transaktionspoolern (6543). Använd session pooler (5432).`);
  process.exit(1);
}
const ca = caFil && existsSync(caFil) ? readFileSync(caFil, 'utf8') : null;

// What the person sees: the host, never the password.
const värd = (() => { try { return new URL(url).host; } catch { return '(ogiltig URL)'; } })();
console.log(`${miljö}: ${värd}${ca ? ', TLS verifieras mot Supabase-certifikatet' : ', UTAN certifikat (TLS ej verifierad)'}`);
if (!ca) console.log(`  lägg certifikatet i ${env[`${P}_CA_FIL`] || `${P}_CA_FIL`} för att verifiera servern`);

const barnEnv = {
  ...process.env,
  DATABASE_URL: url,
  ...(ca ? { DATABASE_CA_CERT: ca } : {}),
  SUPABASE_URL: supabaseUrl,
  SUPABASE_ANON_KEY: anon,
};
const kör = (namn, cmd, args, opts = {}) => {
  process.stdout.write(`→ ${namn}\n`);
  const r = spawnSync(cmd, args, { cwd: ROT, env: barnEnv, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) { console.error(`✗ ${namn} misslyckades`); process.exit(1); }
};

// ---- can we reach it, and what is in it ----
const klient = new pg.Client({ connectionString: url, ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}) });
let innehåll;
try {
  await klient.connect();
  const { rows: [r] } = await klient.query(
    `SELECT current_setting('server_version') AS version,
            (SELECT count(*) FROM pg_tables WHERE schemaname = 'public')::int AS tabeller,
            to_regclass('public.schema_migrations') IS NOT NULL AS migrerad`);
  innehåll = r;
  console.log(`✓ ansluten — Postgres ${r.version.split(' ')[0]}, ${r.tabeller} tabeller i public`);
} catch (err) {
  console.error(`✗ kunde inte ansluta: ${err.message}`);
  if (/self.signed|certificate/i.test(err.message)) {
    console.error('  certifikatet stämmer inte — ladda ner det igen från rätt projekt');
  }
  process.exit(1);
} finally {
  await klient.end().catch(() => {});
}

if (!baraKontroll) {
  if (flytta) {
    // Into an empty project only: restoring over a database that already
    // has the schema fails half-way and leaves both halves.
    if (innehåll.tabeller > 0) {
      console.error(`✗ ${miljö} har redan ${innehåll.tabeller} tabeller — flytten görs bara till ett tomt projekt`);
      process.exit(1);
    }
    // The local worker and janitor write while a dump is taken; stopped
    // first, so what moves is one consistent moment.
    kör('stoppar lokal worker och janitor', 'docker', ['compose', 'stop', 'worker', 'janitor']);
    const mapp = resolve(process.env.USERPROFILE || process.env.HOME || ROT, 'jobbflo-backups');
    mkdirSync(mapp, { recursive: true });
    const fil = `jobbflo-till-${miljö}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.dump`;
    process.stdout.write(`→ dump av den lokala databasen till ${join(mapp, fil)}\n`);
    const dump = spawnSync('docker', ['exec', 'jobbjakt-pg', 'pg_dump', '-U', 'jobbjakt', '-d', 'jobbjakt',
      '-Fc', '--no-owner', '--no-privileges'], { maxBuffer: 2 ** 31 });
    if (dump.status !== 0) { console.error(`✗ pg_dump: ${dump.stderr}`); process.exit(1); }
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(mapp, fil), dump.stdout);
    console.log(`  ${(dump.stdout.length / 1e6).toFixed(0)} MB`);

    // pg_restore 17 in a container, so nothing has to be installed. The
    // CA goes in beside the dump; libpq verifies the chain with it.
    const caArgs = [];
    if (ca) {
      copyFileSync(caFil, join(mapp, 'supabase-ca.crt'));
      caArgs.push('-e', 'PGSSLMODE=verify-ca', '-e', 'PGSSLROOTCERT=/b/supabase-ca.crt');
    } else {
      // Encrypted whenever the server offers it — Supabase always does;
      // a local rehearsal stack does not.
      caArgs.push('-e', 'PGSSLMODE=prefer');
    }
    // Inside the container, "localhost" is the container: a database on
    // this machine (a rehearsal against the local stack) is reached as
    // host.docker.internal. A hosted project's address passes unchanged.
    const urlIContainer = url.replace(/@(127.0.0.1|localhost)([:/])/, '@host.docker.internal$2');
    kör('återställer i Supabase (några minuter)', 'docker', [
      'run', '--rm', '--add-host=host.docker.internal:host-gateway', '-v', `${mapp}:/b`, ...caArgs, 'postgres:17',
      'pg_restore', '--no-owner', '--no-privileges', '-d', urlIContainer, `/b/${fil}`,
    ], { env: { ...barnEnv, MSYS_NO_PATHCONV: '1' } });
    console.log('');
    console.log('  Den lokala workern är stoppad och ska förbli det. Startar du den igen');
    console.log('  kör kampanjerna från två databaser, och arbetsgivare får dubbla brev.');
  }
  kör('migrationer', 'node', ['scripts/migrate.js']);
}

kör('låser Data API', 'node', ['scripts/lock-data-api.js']);
kör('databasen stämmer med migrationerna', 'npm', ['run', 'db:check', '--', '--live']);
kör('Data API med den publika nyckeln läser ingenting', 'node', ['scripts/prove-rls.js']);
console.log(`\n✓ ${miljö} är klar`);
