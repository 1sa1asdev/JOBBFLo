// Proves Google-mode login end to end, against a real Supabase Auth —
// the local stack (`npx supabase start`) stands in for the hosted one,
// with an email link in place of Google (same code exchange, same
// cookies, same callback).
//
//   PROVE_BASE_URL=http://localhost:3100 node scripts/prove-supabase-login.js
//
// The server must run in supabase mode (SUPABASE_URL + SUPABASE_ANON_KEY)
// against the same DATABASE_URL as this script, with
// SUPABASE_EPOSTLANK=1. Needs SUPABASE_SERVICE_ROLE_KEY here to clean up.
//
//   1. no session: API 401, pages go to /login, which offers Google
//   2. the password routes do not exist in this mode
//   3. A signs in by link → /auth/callback makes A's account and profile
//   4. B's session reaches only B's rows; A gets 404 on B's search
//   5. a session whose account was never made gets one on first request
//   6. a verified address takes over its restored local account and
//      profile — the developer's own data after the move to Supabase
//   7. a forged cookie, a made-up code, and signing out all end at 401
import 'dotenv/config';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { pool } from '../src/db.js';

const BAS = process.env.PROVE_BASE_URL || 'http://localhost:3100';
const URL_ = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:55324';
if (!URL_ || !ANON || !SERVICE) {
  console.error('SUPABASE_URL, SUPABASE_ANON_KEY och SUPABASE_SERVICE_ROLE_KEY krävs');
  process.exit(1);
}

const KÖRNING = `${Date.now()}`;
const adress = (namn) => `proof+sb-${namn}-${KÖRNING}@example.invalid`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

// A browser, as far as cookies go.
class Burk {
  constructor() { this.kakor = new Map(); }
  header() { return [...this.kakor].map(([k, v]) => `${k}=${v}`).join('; '); }
  ta(res) {
    for (const rad of res.headers.getSetCookie?.() || []) {
      const [par, ...attr] = rad.split(';');
      const i = par.indexOf('=');
      const namn = par.slice(0, i).trim();
      const värde = par.slice(i + 1).trim();
      const borta = attr.some((a) => /max-age=0/i.test(a)) || värde === '';
      if (borta) this.kakor.delete(namn); else this.kakor.set(namn, värde);
    }
  }
  // A Supabase client that keeps its session in this jar, the way the
  // browser client keeps it in document.cookie.
  supabase() {
    return createServerClient(URL_, ANON, {
      cookies: {
        getAll: () => [...this.kakor].map(([name, value]) => ({ name, value })),
        setAll: (lista) => {
          for (const { name, value, options } of lista) {
            if (!value || options?.maxAge === 0) this.kakor.delete(name);
            else this.kakor.set(name, value);
          }
        },
      },
    });
  }
}

async function anrop(burk, metod, väg, body) {
  const res = await fetch(`${BAS}${väg}`, {
    method: metod,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(burk ? { cookie: burk.header() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  burk?.ta(res);
  let data = null;
  try { data = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, data, location: res.headers.get('location'), text: data ? null : await res.text() };
}

// The newest mail Mailpit holds for an address.
async function länkFrån(till) {
  for (let i = 0; i < 40; i += 1) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${till}`)}`);
    const { messages = [] } = await r.json();
    if (messages.length) {
      const m = await (await fetch(`${MAILPIT}/api/v1/message/${messages[0].ID}`)).json();
      const text = `${m.Text || ''} ${m.HTML || ''}`;
      const hit = text.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]*/);
      if (hit) return hit[0].replace(/&amp;/g, '&');
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error(`inget mejl till ${till}`);
}

// A session without the callback: an email OTP verified straight from
// the jar. Supabase confirms the address by it, like Google does.
async function sessionUtanCallback(burk, email) {
  // An existing, confirmed Supabase user — for an unknown address
  // generateLink hands back a signup token, which a magic-link verify
  // refuses.
  const { error: e0 } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (e0) throw e0;
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const { error: e2 } = await burk.supabase().auth.verifyOtp({
    token_hash: data.properties.hashed_token, type: 'email' });
  if (e2) throw e2;
}

const städa = async () => {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data?.users || []) {
    if (String(u.email).endsWith(`-${KÖRNING}@example.invalid`)) await admin.auth.admin.deleteUser(u.id);
  }
  await pool.query(`DELETE FROM users WHERE email LIKE 'proof+sb-%-${KÖRNING}@example.invalid'`);
  await pool.query(`DELETE FROM profile WHERE email LIKE 'proof+sb-%-${KÖRNING}@example.invalid'`);
};

try {
  // ---- 1 + 2 ----
  const utan = await anrop(null, 'GET', '/api/profile');
  kolla('1. API utan session: 401', utan.status === 401, String(utan.status));
  const sida = await anrop(null, 'GET', '/');
  kolla('1. sida utan session: till /login', [307, 308].includes(sida.status) && /\/login$/.test(sida.location || ''),
    `${sida.status} ${sida.location}`);
  const login = await anrop(null, 'GET', '/login');
  kolla('1. /login erbjuder Google', login.status === 200 && /Fortsätt med Google/.test(login.text || ''));
  const signup = await anrop(null, 'POST', '/api/auth/signup', { name: 'x', email: adress('pw'), password: 'losenord123' });
  const pwlogin = await anrop(null, 'POST', '/api/auth/login', { email: adress('pw'), password: 'losenord123' });
  kolla('2. lösenordsvägarna finns inte i Google-läget', signup.status === 404 && pwlogin.status === 404,
    `${signup.status}/${pwlogin.status}`);

  // ---- 3: the full callback path ----
  const A = new Burk();
  const { error: otpFel } = await A.supabase().auth.signInWithOtp({
    email: adress('a'), options: { emailRedirectTo: `${BAS}/auth/callback` } });
  if (otpFel) throw otpFel;
  const verifiera = await fetch(await länkFrån(adress('a')), { redirect: 'manual' });
  const tillCallback = verifiera.headers.get('location') || '';
  kolla('3. länken leder till /auth/callback med en kod', /\/auth\/callback\?code=/.test(tillCallback), tillCallback.slice(0, 70));
  const cb = await anrop(A, 'GET', new URL(tillCallback).pathname + new URL(tillCallback).search);
  kolla('3. callback loggar in och skickar till startsidan', [303, 307].includes(cb.status) && new URL(cb.location, BAS).pathname === '/',
    `${cb.status} ${cb.location}`);
  const profilA = await anrop(A, 'GET', '/api/profile');
  kolla('3. A når sin egen profil', profilA.status === 200 && profilA.data?.email === adress('a'),
    `${profilA.status} ${profilA.data?.email || profilA.data?.error || ''}`);
  const { rows: [kontoA] } = await pool.query(
    `SELECT u.auth_id IS NOT NULL AS länkad, u.password_hash IS NULL AS utan_lösen, p.id AS profil
     FROM users u JOIN profile p ON p.user_id = u.id WHERE u.email = $1`, [adress('a')]);
  kolla('3. kontot är länkat till Supabase och saknar lösenord', kontoA?.länkad && kontoA?.utan_lösen);

  // ---- 4 + 5 ----
  const B = new Burk();
  await sessionUtanCallback(B, adress('b'));
  const profilB = await anrop(B, 'GET', '/api/profile');
  kolla('5. session utan callback: kontot skapas vid första anropet',
    profilB.status === 200 && profilB.data?.email === adress('b'), `${profilB.status} ${profilB.data?.error || ''}`);
  const { rows: [kontoB] } = await pool.query(
    `SELECT p.id FROM users u JOIN profile p ON p.user_id = u.id WHERE u.email = $1`, [adress('b')]);
  const { rows: [sökB] } = await pool.query(
    `INSERT INTO searches (profile_id, name, criteria_text) VALUES ($1, 'B:s sökning', 'x') RETURNING id`, [kontoB.id]);
  const somA = await anrop(A, 'GET', `/api/searches/${sökB.id}`);
  const somB = await anrop(B, 'GET', `/api/searches/${sökB.id}`);
  kolla('4. A får 404 på B:s sökning, B når den', somA.status === 404 && somB.status === 200,
    `A ${somA.status}, B ${somB.status}`);

  // ---- 6: the restored local account ----
  const { rows: [gammal] } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'scrypt$1$x$y') RETURNING id`, [adress('c')]);
  const { rows: [gammalProfil] } = await pool.query(
    `INSERT INTO profile (user_id, name, email, cv_text) VALUES ($1, 'Återställd', $2, 'mitt gamla CV') RETURNING id`,
    [gammal.id, adress('c')]);
  const C = new Burk();
  await sessionUtanCallback(C, adress('c'));
  const profilC = await anrop(C, 'GET', '/api/profile');
  kolla('6. verifierad adress tar över sitt återställda konto och profil',
    profilC.status === 200 && profilC.data?.cv_text === 'mitt gamla CV', `${profilC.status}`);
  const { rows: [c] } = await pool.query(
    `SELECT u.id = $2 AS samma_konto, (SELECT count(*)::int FROM profile WHERE email = $1) AS profiler
     FROM users u WHERE u.email = $1`, [adress('c'), gammal.id]);
  kolla('6. inget nytt konto och ingen ny profil skapades', c?.samma_konto && c?.profiler === 1 && gammalProfil.id,
    JSON.stringify(c));

  // ---- 7 ----
  const förfalskad = new Burk();
  for (const [k, v] of A.kakor) förfalskad.kakor.set(k, v.slice(0, -12) + 'AAAAAAAAAAAA');
  const ff = await anrop(förfalskad, 'GET', '/api/profile');
  kolla('7. förfalskad cookie: 401', ff.status === 401, String(ff.status));
  const påhittad = await anrop(new Burk(), 'GET', '/auth/callback?code=pahittad-kod');
  kolla('7. påhittad kod: tillbaka till /login med en felkod',
    /\/login\?fel=annan-webblasare$/.test(påhittad.location || ''), `${påhittad.status} ${påhittad.location?.slice(0, 60)}`);
  const lurad = await anrop(null, 'GET', `/login?fel=${encodeURIComponent('Ring 070-000 00 00 för att låsa upp kontot')}`);
  // What is shown, not Next's router data — that carries the URL itself.
  const synligt = (lurad.text || '').replace(/<script[\s\S]*?<\/script>/g, '');
  kolla('7. /login visar aldrig fritext ur URL:en',
    lurad.status === 200 && !/Ring 070/.test(synligt) && /gick inte igenom/.test(synligt));
  const ut = await anrop(A, 'POST', '/api/auth/logout');
  const efter = await anrop(A, 'GET', '/api/profile');
  kolla('7. utloggad: 401', ut.status === 200 && efter.status === 401, `${ut.status} → ${efter.status}`);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  await städa().catch((e) => console.error('städning:', e.message));
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
