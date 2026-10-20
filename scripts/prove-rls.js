// Proves the database answers only to the server.
//
//   node scripts/prove-rls.js
//
// Supabase publishes every table in public through its Data API, and the
// key that reaches it (the anon key) ships to every browser. Before
// migration 053 that returned a stranger's CV. The app never uses the
// Data API — the server talks to Postgres as the tables' owner — so:
//
//   1. every table in public has row level security, and no policies
//      (a policy would be a door; nothing here is meant to open one)
//   2. every view runs as its caller, not as its owner
//   3. on Supabase: the Data API roles hold no rights on public
//   4. with SUPABASE_URL and SUPABASE_ANON_KEY set: asking the Data API
//      for real returns nothing
//
// 1 and 2 run in CI on plain Postgres, where a migration that adds a
// table without RLS fails the build. 3 and 4 run against a Supabase
// database (a local `npx supabase start`, or the hosted one).
import 'dotenv/config';
import { pool } from '../src/db.js';

let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(60)}${info ? ` ${info}` : ''}`);
};

try {
  const { rows: utan } = await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
     ORDER BY 1`);
  kolla('1. varje tabell har RLS', utan.length === 0, utan.map((r) => r.relname).join(', '));

  const { rows: regler } = await pool.query(
    `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`);
  kolla('1. inga policyer som öppnar något', regler.length === 0,
    regler.map((r) => `${r.tablename}.${r.policyname}`).join(', '));

  const { rows: vyer } = await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
       AND NOT coalesce('security_invoker=true' = ANY(c.reloptions), false)
     ORDER BY 1`);
  kolla('2. varje vy körs som anroparen', vyer.length === 0, vyer.map((r) => r.relname).join(', '));

  const { rows: [roll] } = await pool.query(`SELECT 1 AS finns FROM pg_roles WHERE rolname = 'anon'`);
  if (roll) {
    const { rows: rätter } = await pool.query(
      `SELECT c.relname, r.rolname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
         AND (has_table_privilege(r.rolname, c.oid, 'SELECT')
           OR has_table_privilege(r.rolname, c.oid, 'INSERT')
           OR has_table_privilege(r.rolname, c.oid, 'UPDATE')
           OR has_table_privilege(r.rolname, c.oid, 'DELETE'))`);
    kolla('3. Data API:ts roller har inga rättigheter i public', rätter.length === 0,
      rätter.slice(0, 6).map((r) => `${r.rolname}:${r.relname}`).join(', '));
  } else {
    console.log('– 3. ingen Supabase-roll i den här databasen (vanlig Postgres) — hoppar över');
  }

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && anon) {
    const läckor = [];
    for (const tabell of ['profile', 'users', 'applications', 'email_messages', 'ad_reads', 'search_results']) {
      const res = await fetch(`${url}/rest/v1/${tabell}?select=*&limit=1`, {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      });
      const text = await res.text();
      // Refused (401/403/404) or an empty list. Anything with a row in
      // it is a leak.
      if (res.ok && text.trim() !== '[]') läckor.push(`${tabell} (${res.status})`);
    }
    kolla('4. Data API med anon-nyckeln: ingenting att hämta', läckor.length === 0, läckor.join(', '));
  } else {
    console.log('– 4. SUPABASE_URL/SUPABASE_ANON_KEY saknas — hoppar över provet mot Data API');
  }
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.message);
} finally {
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
