// Shuts Supabase's Data API out of public — the same as migration 053,
// runnable any number of times.
//
//   node scripts/lock-data-api.js
//
// Why a script as well as the migration: a migration runs once, and a
// restored dump comes back WITHOUT it having run. pg_restore creates the
// tables anew as postgres, and on Supabase the project's default
// privileges then grant every one of them to anon and authenticated
// again. RLS (restored with the tables) still keeps every row in, but a
// grant that should not exist is a policy away from a leak. The deploy
// workflow runs this before checking, and DEPLOY.md runs it after a
// restore. scripts/prove-rls.js proves the result.
import 'dotenv/config';
import { pool } from '../src/db.js';

const { rows: tabeller } = await pool.query(
  `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity`);
for (const { relname } of tabeller) {
  await pool.query(`ALTER TABLE public."${relname.replace(/"/g, '""')}" ENABLE ROW LEVEL SECURITY`);
}

const { rows: vyer } = await pool.query(
  `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'v'
     AND NOT coalesce('security_invoker=true' = ANY(c.reloptions), false)`);
for (const { relname } of vyer) {
  await pool.query(`ALTER VIEW public."${relname.replace(/"/g, '""')}" SET (security_invoker = true)`);
}

const { rows: [supabase] } = await pool.query(`SELECT 1 AS ja FROM pg_roles WHERE rolname = 'anon'`);
if (supabase) {
  for (const sql of [
    'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated',
    'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated',
    'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated',
  ]) await pool.query(sql);
}
await pool.end();

console.log(`✓ RLS påslaget på ${tabeller.length} tabeller som saknade det, `
  + `${vyer.length} vyer körs nu som anroparen`
  + `${supabase ? ', Data API:ts roller saknar rättigheter i public' : ' (ingen Supabase-roll här)'}`);
