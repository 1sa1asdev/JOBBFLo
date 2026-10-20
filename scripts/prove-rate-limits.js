// Proves the routes someone could hammer stop answering past their limit.
//
//   PROVE_BASE_URL=http://localhost:3100 node scripts/prove-rate-limits.js
//
// Needs a server with password login on (AUTH_SECRET), against the same
// DATABASE_URL as this script.
//
//   1. password guessing from one address: 429 after the limit
//   2. "Hämta post" from one user: 429 after the limit — each press is a
//      Gmail connection on their account
//   3. the export: 429 after the limit
//   4. one user's limit is not another's
//
// The counts live in Postgres (rate_limits), because Vercel's instances
// share nothing else. Nothing here talks to Gmail: the users have no
// app password, so a sync answers 409 before connecting.
import 'dotenv/config';
import { pool } from '../src/db.js';

const BAS = process.env.PROVE_BASE_URL || 'http://localhost:3100';
const KÖRNING = `${Date.now()}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};

const anrop = async (cookie, metod, väg, body, headers = {}) => {
  const res = await fetch(`${BAS}${väg}`, {
    method: metod, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  await res.arrayBuffer();
  return res.status;
};

async function användare(namn) {
  const email = `proof+takt-${namn}-${KÖRNING}@example.invalid`;
  const res = await fetch(`${BAS}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Bevis ${namn}`, email, password: `losenord-${KÖRNING}` }),
  });
  if (res.status !== 201) throw new Error(`signup ${namn}: ${res.status}`);
  return { email, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

// Status codes of n calls in a row, then the one after.
async function serie(n, fn) {
  const före = [];
  for (let i = 0; i < n; i += 1) före.push(await fn());
  return { före, efter: await fn() };
}

try {
  const A = await användare('a');
  const B = await användare('b');

  // ---- 1 ----
  const ip = `203.0.113.${1 + (Number(KÖRNING) % 250)}`;
  const gissa = () => anrop(null, 'POST', '/api/auth/login',
    { email: A.email, password: 'fel-lösenord' }, { 'x-forwarded-for': ip });
  const g = await serie(20, gissa);
  kolla('1. lösenordsgissning: 401 upp till gränsen, sedan 429',
    g.före.every((s) => s === 401) && g.efter === 429, `${g.före.filter((s) => s === 401).length}×401, sedan ${g.efter}`);
  const annanIp = await anrop(null, 'POST', '/api/auth/login',
    { email: A.email, password: `losenord-${KÖRNING}` }, { 'x-forwarded-for': '198.51.100.7' });
  kolla('1. en annan adress loggar in som vanligt', annanIp === 200, String(annanIp));

  // ---- 2 ----
  const h = await serie(30, () => anrop(A.cookie, 'POST', '/api/inbox/sync'));
  kolla('2. Hämta post: 429 efter gränsen', h.efter === 429 && !h.före.includes(429),
    `${h.före.length} svar (${[...new Set(h.före)].join(',')}), sedan ${h.efter}`);

  // ---- 3 ----
  const e = await serie(10, () => anrop(A.cookie, 'GET', '/api/account/export'));
  kolla('3. exporten: 429 efter gränsen', e.före.every((s) => s === 200) && e.efter === 429,
    `${e.före.filter((s) => s === 200).length}×200, sedan ${e.efter}`);

  // ---- 4 ----
  const b = await anrop(B.cookie, 'GET', '/api/account/export');
  kolla('4. B:s gräns är B:s egen', b === 200, String(b));
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  await pool.query(`DELETE FROM users WHERE email LIKE 'proof+takt-%-${KÖRNING}@example.invalid'`);
  await pool.query(`DELETE FROM rate_limits WHERE nyckel LIKE '%203.0.113.%' OR nyckel LIKE '%198.51.100.7%'`).catch(() => {});
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
