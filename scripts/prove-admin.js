// Proves the admin pages answer only the operator, and that what they
// change takes effect where it matters.
//
//   PROVE_BASE_URL=http://localhost:3100 node scripts/prove-admin.js
//
// Needs a server with password login on (AUTH_SECRET), against the same
// DATABASE_URL as this script — the same server prove-owner-checks uses.
//
//   1. a user who is not admin gets 404 on every admin route and page —
//      the same answer as a page that does not exist
//   2. the admin sees the pool's health and every user, without their
//      CVs or letters
//   3. the embedding switch is the platform's: flipped by the admin, read
//      by the worker, no longer a profile setting anyone can reach
//   4. blocking a user: their requests get 403, their campaigns pause
//      with a reason, their mailbox closes; unblocking lets them in and
//      leaves the campaign for them to start again
//   5. the admin cannot block themselves out
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
    method: metod,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  let data = null;
  try { data = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}

async function användare(namn) {
  const email = `proof+admin-${namn}-${KÖRNING}@example.invalid`;
  const res = await fetch(`${BAS}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Bevis ${namn}`, email, password: `losenord-${KÖRNING}` }),
  });
  if (res.status !== 201) throw new Error(`signup ${namn}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const { rows: [r] } = await pool.query(
    `SELECT u.id AS user_id, p.id AS profile_id FROM users u JOIN profile p ON p.user_id = u.id
     WHERE u.email = $1`, [email]);
  return { email, cookie, userId: r.user_id, profileId: r.profile_id };
}

let tidigareEmbed = null;
try {
  const A = await användare('a');
  const B = await användare('b');
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [B.userId]);
  await pool.query(`UPDATE profile SET cv_text = 'A:s hemliga CV-text' WHERE id = $1`, [A.profileId]);

  // ---- 1 ----
  const vägar = [
    ['GET', '/api/admin/oversikt'], ['GET', '/api/admin/anvandare'],
    ['PATCH', '/api/admin/installningar', { embeddings: false }],
    ['PATCH', `/api/admin/anvandare/${B.userId}`, { spärrad: true }],
  ];
  const somA = await Promise.all(vägar.map(([m, v, b]) => anrop(A.cookie, m, v, b)));
  kolla('1. vanlig användare: 404 på varje adminväg', somA.every((r) => r.status === 404),
    somA.map((r) => r.status).join(','));
  const sidaA = await anrop(A.cookie, 'GET', '/admin');
  kolla('1. vanlig användare: /admin finns inte', sidaA.status === 404, String(sidaA.status));

  // ---- 2 ----
  const översikt = await anrop(B.cookie, 'GET', '/api/admin/oversikt');
  kolla('2. admin ser poolens hälsa', översikt.status === 200
    && Number.isFinite(översikt.data?.pool?.öppna) && 'embeddings' in (översikt.data || {}),
    `${översikt.status} ${översikt.data?.error || ''}`);
  const lista = await anrop(B.cookie, 'GET', '/api/admin/anvandare');
  const raderA = lista.data?.användare?.filter((u) => u.email === A.email) || [];
  kolla('2. admin ser användarna', lista.status === 200 && raderA.length === 1
    && lista.data.användare.some((u) => u.email === B.email && u.role === 'admin'), String(lista.status));
  kolla('2. … men inte deras CV', !JSON.stringify(lista.data || {}).includes('hemliga CV-text'));
  const sidaB = await anrop(B.cookie, 'GET', '/admin');
  kolla('2. admin når /admin', sidaB.status === 200, String(sidaB.status));

  // ---- 3 ----
  let platform = null;
  try { platform = await import('../src/platform.js'); } catch { /* old code */ }
  if (!platform) {
    kolla('3. plattformsinställningar finns', false, 'src/platform.js saknas');
  } else {
    tidigareEmbed = await platform.embeddingsPåslagna();
    const av = await anrop(B.cookie, 'PATCH', '/api/admin/installningar', { embeddings: !tidigareEmbed });
    kolla('3. admin slår om embeddings, workern läser samma värde',
      av.status === 200 && (await platform.embeddingsPåslagna()) === !tidigareEmbed, String(av.status));
    const gammal = await anrop(A.cookie, 'PATCH', '/api/profile/embeddings', { enabled: true });
    kolla('3. ingen profilväg slår om plattformens kostnad', gammal.status === 404 || gammal.status === 405,
      String(gammal.status));
  }

  // ---- 4 ----
  const { rows: [kampanj] } = await pool.query(
    `INSERT INTO searches (profile_id, name, criteria_text, auto_apply_enabled, campaign_created_at)
     VALUES ($1, 'A:s kampanj', 'x', true, now()) RETURNING id`, [A.profileId]);
  await pool.query(
    `UPDATE profile SET gmail_app_password_enc = 'v1.x.y.z', gmail_verified_at = now() WHERE id = $1`, [A.profileId]);
  const { rows: [ad] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description)
     VALUES ('manual', $1, $1, 'Bevis', 'Bevis AB', 'x') RETURNING id`, [`prove-admin-${KÖRNING}`]);
  await pool.query(
    `INSERT INTO applications (ad_id, profile_id, status, subject, letter_text, sent_to, sent_at)
     VALUES ($1, $2, 'sent', 's', 'l', 'jobb@example.invalid', now())`, [ad.id, A.profileId]);
  const { harBrevlåda } = await import('../src/imapManager.js');
  kolla('4. före spärren har A en brevlåda', await harBrevlåda(A.profileId));

  const spärr = await anrop(B.cookie, 'PATCH', `/api/admin/anvandare/${A.userId}`, { spärrad: true });
  const spärradA = await anrop(A.cookie, 'GET', '/api/profile');
  kolla('4. spärrad användare får 403', spärr.status === 200 && spärradA.status === 403,
    `${spärr.status} → ${spärradA.status}`);
  // Routes that catch their own errors must not turn the 403 into theirs.
  const fångande = await Promise.all([
    anrop(A.cookie, 'POST', '/api/inbox/sync'),
    anrop(A.cookie, 'POST', '/api/applications', { adId: '00000000-0000-0000-0000-000000000000' }),
  ]);
  kolla('4. … även i routrar som fångar sina egna fel', fångande.every((r) => r.status === 403),
    fångande.map((r) => r.status).join(','));
  const { rows: [k1] } = await pool.query(
    `SELECT auto_apply_enabled, auto_apply_paused_reason FROM searches WHERE id = $1`, [kampanj.id]);
  kolla('4. kampanjen pausas, med orsak', k1.auto_apply_enabled === false && /spärr/i.test(k1.auto_apply_paused_reason || ''),
    k1.auto_apply_paused_reason || '');
  kolla('4. brevlådan stängs', !(await harBrevlåda(A.profileId)));

  const upp = await anrop(B.cookie, 'PATCH', `/api/admin/anvandare/${A.userId}`, { spärrad: false });
  const igenA = await anrop(A.cookie, 'GET', '/api/profile');
  const { rows: [k2] } = await pool.query(`SELECT auto_apply_enabled FROM searches WHERE id = $1`, [kampanj.id]);
  kolla('4. upplåst: A kommer in, kampanjen väntar på A', upp.status === 200 && igenA.status === 200 && k2.auto_apply_enabled === false,
    `${upp.status} → ${igenA.status}`);

  // ---- 6: an error nobody caught reaches the admin page ----
  const trasig = await fetch(`${BAS}/api/searches`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie }, body: '{"trasig',
  });
  await trasig.arrayBuffer();
  await new Promise((ok) => setTimeout(ok, 800));
  const medFel = await anrop(B.cookie, 'GET', '/api/admin/oversikt');
  kolla('6. ett ofångat fel syns på adminsidan', trasig.status === 500
    && (medFel.data?.fel || []).some((f) => f.väg === '/api/searches' && f.källa === 'app'),
    `${trasig.status} → ${(medFel.data?.fel || []).length} fel i listan`);

  // ---- 5 ----
  const själv = await anrop(B.cookie, 'PATCH', `/api/admin/anvandare/${B.userId}`, { spärrad: true });
  const bIgen = await anrop(B.cookie, 'GET', '/api/admin/oversikt');
  kolla('5. admin kan inte spärra sig själv', själv.status === 400 && bIgen.status === 200, `${själv.status}`);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  if (tidigareEmbed !== null) {
    const platform = await import('../src/platform.js');
    await platform.sättPlattformsinställning('embeddings_enabled', tidigareEmbed, null).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE email LIKE 'proof+admin-%-${KÖRNING}@example.invalid'`);
  await pool.query(`DELETE FROM ads WHERE external_id = $1`, [`prove-admin-${KÖRNING}`]);
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
