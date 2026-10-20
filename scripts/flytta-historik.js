// Moves your local Jobbflo history into your account in the hosted app.
//
//   node scripts/flytta-historik.js staging
//   node scripts/flytta-historik.js production
//
// Options:
//   --konto <e-post>   the cloud account to move into (default: the local
//                      profile's address)
//   --från <e-post>    the local profile to move (default: the only one)
//   --fil <sökväg>     another settings file than .env.supabase
//
// Before running it: sign in to the hosted app once with Google, so the
// account exists. Moves into an account with no searches or applications
// only (src/flytt.js says why and what moves). Your campaigns arrive
// paused; restart them in the cloud once the local worker is off.
import 'dotenv/config';
import { resolve } from 'node:path';
import pg from 'pg';
import { anslutning } from '../src/dbConfig.js';
import { flyttaHistorik } from '../src/flytt.js';
import { läsMiljö, värd, pgInställning } from './miljo.js';

const [miljö, ...flaggor] = process.argv.slice(2);
const flagga = (namn) => { const i = flaggor.indexOf(namn); return i >= 0 ? flaggor[i + 1] : null; };
if (!['staging', 'production'].includes(miljö)) {
  console.error('användning: node scripts/flytta-historik.js staging|production [--konto e-post] [--från e-post]');
  process.exit(1);
}

let m;
try { m = läsMiljö(miljö, flagga('--fil') ? resolve(flagga('--fil')) : undefined); } catch (err) {
  console.error(err.message); process.exit(1);
}

const från = new pg.Client(anslutning(process.env.DATABASE_URL));
const till = new pg.Client(pgInställning(m));
try {
  await från.connect();
  await till.connect();

  const frånEpost = flagga('--från');
  const { rows: källor } = await från.query(
    `SELECT id, email FROM profile ${frånEpost ? 'WHERE lower(email) = lower($1)' : ''}`,
    frånEpost ? [frånEpost] : []);
  if (källor.length !== 1) {
    throw new Error(källor.length
      ? `${källor.length} lokala profiler — ange vilken med --från <e-post>`
      : 'ingen lokal profil hittades');
  }
  const källa = källor[0];
  const målEpost = flagga('--konto') || källa.email;
  const { rows: [mål] } = await till.query(
    `SELECT p.id FROM users u JOIN profile p ON p.user_id = u.id WHERE lower(u.email) = lower($1)`, [målEpost]);
  if (!mål) throw new Error(`inget konto för ${målEpost} i ${miljö} — logga in med Google i molnappen en gång först`);

  console.log(`flyttar lokal historik → ${miljö} (${värd(m.url)}), konto ${målEpost}`);
  const start = Date.now();
  const räkning = await flyttaHistorik({ från, till, frånProfil: källa.id, tillProfil: mål.id });
  for (const [tabell, n] of Object.entries(räkning)) {
    const text = typeof n === 'number' ? n : Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ');
    if (text && text !== '0') console.log(`  ${tabell.padEnd(20)} ${text}`);
  }
  console.log(`✓ klart på ${Math.round((Date.now() - start) / 1000)} s`);
  console.log('');
  console.log('  Kampanjerna kom fram pausade. Stäng av den lokala workern innan du startar');
  console.log('  dem i molnet (docker compose stop worker janitor) — annars skickar båda.');
  console.log('  Lägg in Gmail-applösenordet och AI-nyckeln igen under Profil: nycklar flyttas inte.');
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await från.end().catch(() => {});
  await till.end().catch(() => {});
}
