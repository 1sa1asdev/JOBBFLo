// Proves a user can take their data with them and have it erased —
// GDPR's access, portability and erasure, checked against every table
// rather than a list someone has to remember to update.
//
//   PROVE_BASE_URL=http://localhost:3100 node scripts/prove-account.js
//
// Needs a server with password login on (AUTH_SECRET), against the same
// DATABASE_URL as this script.
//
//   1. the export holds A's rows and nothing of B's — no password hash,
//      no encrypted secrets, no file bytes
//   2. deleting needs the account's own address typed in; a wrong one
//      deletes nothing
//   3. after deletion, NO table holds a row pointing at A's account,
//      profile, searches or applications — found by walking every foreign
//      key in the schema, so a table added next year is covered too
//   4. B is untouched, and A's session reaches nothing
import 'dotenv/config';
import { pool } from '../src/db.js';

const BAS = process.env.PROVE_BASE_URL || 'http://localhost:3100';
const KÖRNING = `${Date.now()}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};

async function anrop(cookie, metod, väg, body) {
  const res = await fetch(`${BAS}${väg}`, {
    method: metod, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  let data = null;
  try { data = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, data, disposition: res.headers.get('content-disposition') };
}

async function användare(namn) {
  const email = `proof+konto-${namn}-${KÖRNING}@example.invalid`;
  const res = await fetch(`${BAS}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Bevis ${namn}`, email, password: `losenord-${KÖRNING}` }),
  });
  if (res.status !== 201) throw new Error(`signup ${namn}: ${res.status}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const { rows: [r] } = await pool.query(
    `SELECT u.id AS user_id, p.id AS profile_id FROM users u JOIN profile p ON p.user_id = u.id WHERE u.email = $1`,
    [email]);
  return { email, cookie, userId: r.user_id, profileId: r.profile_id };
}

// A row in everything a user can own, marked with their name.
async function fyll(u, namn) {
  const q = (sql, p) => pool.query(sql, p).then((r) => r.rows[0]);
  await q(`UPDATE profile SET cv_text = $2, gmail_app_password_enc = 'v1.HEMLIG.HEMLIG.HEMLIG',
             cv_file = '\\x255044462d', cv_filename = 'cv.pdf' WHERE id = $1`, [u.profileId, `${namn}:s CV`]);
  const ad = await q(`INSERT INTO ads (source, external_id, fingerprint, title, employer, description)
    VALUES ('manual', $1, $1, 'Bevis', 'Bevis AB', 'x') RETURNING id`, [`prove-konto-${KÖRNING}-${namn}`]);
  const egen = await q(`INSERT INTO ads (source, external_id, fingerprint, title, employer, description, owner_profile_id)
    VALUES ('manual', $1, $1, $3, 'Privat AB', 'x', $2) RETURNING id`,
  [`prove-konto-${KÖRNING}-${namn}-egen`, u.profileId, `${namn}:s egna annons`]);
  const sök = await q(`INSERT INTO searches (profile_id, name, criteria_text) VALUES ($1, $2, 'x') RETURNING id`,
    [u.profileId, `${namn}:s sökning`]);
  await q(`INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'user', $2)`, [sök.id, `${namn}:s chatt`]);
  // A candidate tied to one of the user's projects: the cascade has to
  // remove the project while that row still points at it.
  const projekt = await q(`INSERT INTO projects (profile_id, name, summary) VALUES ($1, $2, 'x') RETURNING id`,
    [u.profileId, `${namn}:s projekt`]);
  await q(`INSERT INTO match_results (search_id, ad_id, lead_project_id) VALUES ($1, $2, $3)`, [sök.id, ad.id, projekt.id]);
  const ans = await q(`INSERT INTO applications (ad_id, profile_id, origin_search_id, status, subject, letter_text)
    VALUES ($1, $2, $3, 'drafted', 's', $4) RETURNING id`, [egen.id, u.profileId, sök.id, `${namn}:s brev`]);
  await q(`INSERT INTO email_messages (application_id, direction, from_addr, to_addr, subject, body_text, sent_at)
    VALUES ($1, 'inbound', 'hr@example.invalid', 'x@example.invalid', 'Svar', $2, now())`, [ans.id, `${namn}:s mejl`]);
  await q(`INSERT INTO ad_reads (ad_id, profile_id, status, profile) VALUES ($1, $2, 'ok', '{}')`, [ad.id, u.profileId]);
  await q(`INSERT INTO ad_checks (ad_id, profile_id, cv_key, items) VALUES ($1, $2, 'k', '[]')`, [ad.id, u.profileId]);
  await q(`INSERT INTO never_apply (profile_id, fingerprint) VALUES ($1, $2)`, [u.profileId, `fp-${namn}-${KÖRNING}`]);
  await q(`INSERT INTO ad_contacts (ad_id, profile_id, email) VALUES ($1, $2, 'kontakt@example.invalid')`, [ad.id, u.profileId]);
  await q(`INSERT INTO llm_usage (provider, model, tier, usd, profile_id) VALUES ('x', 'x', 'bulk', 0.001, $1)`, [u.profileId]);
  await q(`INSERT INTO auto_apply_log (search_id, application_id, outcome, detail) VALUES ($1, $2, 'sent', $3)`,
    [sök.id, ans.id, `${namn}:s logg`]);
  return { searchIds: [sök.id], applicationIds: [ans.id] };
}

// Every foreign key in public that points at one of these tables, and
// how many rows still point at the given ids.
async function kvarstående(ids) {
  const { rows: fk } = await pool.query(
    `SELECT src.relname AS tabell, a.attname AS kolumn, dst.relname AS mot
     FROM pg_constraint c
     JOIN pg_class src ON src.oid = c.conrelid
     JOIN pg_class dst ON dst.oid = c.confrelid
     JOIN pg_namespace n ON n.oid = src.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND n.nspname = 'public' AND array_length(c.conkey, 1) = 1
       AND dst.relname IN ('users', 'profile', 'searches', 'applications')`);
  const per = { users: [ids.userId], profile: [ids.profileId], searches: ids.searchIds, applications: ids.applicationIds };
  const kvar = [];
  for (const { tabell, kolumn, mot } of fk) {
    const { rows: [r] } = await pool.query(
      `SELECT count(*)::int AS n FROM public."${tabell}" WHERE "${kolumn}" = ANY($1::uuid[])`, [per[mot]]);
    if (r.n) kvar.push(`${tabell}.${kolumn}: ${r.n}`);
  }
  for (const [t, id] of [['users', ids.userId], ['profile', ids.profileId]]) {
    const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE id = $1`, [id]);
    if (r.n) kvar.push(`${t}: ${r.n}`);
  }
  return { kvar, fk: fk.length };
}

try {
  const A = await användare('a');
  const B = await användare('b');
  const aIds = await fyll(A, 'A');
  await fyll(B, 'B');
  const räknaB = async () => (await pool.query(
    `SELECT (SELECT count(*) FROM searches WHERE profile_id = $1)
          + (SELECT count(*) FROM applications WHERE profile_id = $1)
          + (SELECT count(*) FROM ad_reads WHERE profile_id = $1) AS n`, [B.profileId])).rows[0].n;
  const bFöre = await räknaB();

  // ---- 0: every foreign key into a user's data says what happens on delete ----
  const { rows: utanRegel } = await pool.query(
    `SELECT src.relname || '.' || a.attname AS kolumn
     FROM pg_constraint c JOIN pg_class src ON src.oid = c.conrelid
     JOIN pg_class dst ON dst.oid = c.confrelid
     JOIN pg_namespace n ON n.oid = src.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND n.nspname = 'public' AND c.confdeltype IN ('a', 'r')`);
  kolla('0. varje främmande nyckel har en regel för radering', utanRegel.length === 0,
    utanRegel.map((r) => r.kolumn).join(', '));

  // ---- 1 ----
  const ex = await anrop(A.cookie, 'GET', '/api/account/export');
  const text = JSON.stringify(ex.data || {});
  kolla('1. exporten laddas ner', ex.status === 200 && /attachment/.test(ex.disposition || ''), String(ex.status));
  kolla('1. A:s rader finns med', ['A:s CV', 'A:s sökning', 'A:s chatt', 'A:s brev', 'A:s mejl', 'A:s egna annons']
    .every((t) => text.includes(t)));
  kolla('1. inget av B:s', !/B:s /.test(text));
  kolla('1. inga hemligheter eller lösenordshashar', !text.includes('HEMLIG') && !/scrypt\$/.test(text)
    && !/password_hash|_enc"/.test(text));
  kolla('1. filer som en notering, inte som bytes', /\[fil, \d+ byte\]/.test(text));

  // ---- 2 ----
  const fel1 = await anrop(A.cookie, 'DELETE', '/api/account', { bekräfta: 'någon@annan.invalid' });
  const { rows: [finns] } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [A.userId]);
  kolla('2. fel adress: ingenting raderas', fel1.status === 400 && finns.n === 1, String(fel1.status));

  // ---- 3 ----
  const rad = await anrop(A.cookie, 'DELETE', '/api/account', { bekräfta: A.email });
  const { kvar, fk } = await kvarstående({ userId: A.userId, profileId: A.profileId, ...aIds });
  kolla('3. kontot raderat', rad.status === 200, String(rad.status));
  kolla(`3. ingen rad pekar längre på A (${fk} främmande nycklar genomgångna)`, kvar.length === 0, kvar.join(', '));
  const { rows: [logg] } = await pool.query(
    `SELECT count(*)::int AS n FROM auto_apply_log WHERE detail = 'A:s logg'`);
  kolla('3. kampanjloggens text raderad, inte bara frikopplad', logg.n === 0);
  const { rows: [kost] } = await pool.query(
    `SELECT count(*)::int AS n FROM llm_usage WHERE profile_id = $1`, [A.profileId]);
  kolla('3. kostnadsrader finns bara kvar utan ägare (anonyma siffror)', kost.n === 0);

  // ---- 4 ----
  kolla('4. B orörd', (await räknaB()) === bFöre);
  const efter = await anrop(A.cookie, 'GET', '/api/profile');
  kolla('4. A:s session når ingenting', efter.status === 401, String(efter.status));
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  await pool.query(`DELETE FROM auto_apply_log WHERE detail IN ('A:s logg', 'B:s logg')`).catch(() => {});
  await pool.query(`DELETE FROM users WHERE email LIKE 'proof+konto-%-${KÖRNING}@example.invalid'`);
  await pool.query(`DELETE FROM ads WHERE external_id LIKE 'prove-konto-${KÖRNING}%'`);
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
