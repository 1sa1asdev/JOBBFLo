// The hosted environments' settings, from .env.supabase (gitignored).
// Shared by setup-supabase.js and flytta-historik.js; never prints a
// secret — värd() is what goes on screen.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function läsMiljö(miljö, fil = join(ROT, '.env.supabase')) {
  if (!['staging', 'production'].includes(miljö)) throw new Error('miljön är staging eller production');
  if (!existsSync(fil)) throw new Error(`${fil} saknas`);
  const env = dotenv.parse(readFileSync(fil));
  const P = miljö === 'staging' ? 'STAGING' : 'PROD';
  const url = env[`${P}_DATABASE_URL`]?.trim();
  const supabaseUrl = env[`${P}_SUPABASE_URL`]?.trim();
  const anon = env[`${P}_SUPABASE_ANON_KEY`]?.trim();
  const caNamn = env[`${P}_CA_FIL`]?.trim();
  const caFil = caNamn ? resolve(ROT, caNamn) : null;
  const saknas = [!url && `${P}_DATABASE_URL`, !supabaseUrl && `${P}_SUPABASE_URL`, !anon && `${P}_SUPABASE_ANON_KEY`]
    .filter(Boolean);
  if (saknas.length) throw new Error(`fyll i ${saknas.join(', ')} i .env.supabase`);
  if (/\[YOUR-PASSWORD\]/i.test(url)) throw new Error(`${P}_DATABASE_URL innehåller fortfarande [YOUR-PASSWORD]`);
  if (/:6543\//.test(url)) throw new Error(`${P}_DATABASE_URL pekar på transaktionspoolern (6543). Använd session pooler (5432).`);
  const ca = caFil && existsSync(caFil) ? readFileSync(caFil, 'utf8') : null;
  return { miljö, P, url, supabaseUrl, anon, ca, caFil, caNamn };
}

export const värd = (url) => { try { return new URL(url).host; } catch { return '(ogiltig URL)'; } };
export const pgInställning = ({ url, ca }) => ({ connectionString: url, ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}) });
