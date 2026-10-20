import { pool } from './db.js';
import { inloggningsläge } from './authMode.js';
import { supabaseAdmin } from './supabase.js';

// ------------------------------------------------------------
// A user's right to take their data and to have it erased (GDPR art.
// 15, 17, 20).
//
// Both walk the schema instead of a list: every table with a foreign
// key to the user's account, profile, searches or applications. A list
// would be correct the day it was written and miss the next table
// anyone adds; the walk cannot. scripts/prove-account.js checks the
// erasure the same way.
// ------------------------------------------------------------

const ÄGARE = ['users', 'profile', 'searches', 'applications'];

// Every single-column foreign key in public that points at one of the
// user's own tables.
async function nycklarTillAnvändaren() {
  const { rows } = await pool.query(
    `SELECT src.relname AS tabell, a.attname AS kolumn, dst.relname AS mot
     FROM pg_constraint c
     JOIN pg_class src ON src.oid = c.conrelid
     JOIN pg_class dst ON dst.oid = c.confrelid
     JOIN pg_namespace n ON n.oid = src.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND n.nspname = 'public' AND array_length(c.conkey, 1) = 1
       AND dst.relname = ANY($1)
     ORDER BY 1, 2`, [ÄGARE]);
  return rows;
}

async function användarensId(userId) {
  const { rows: [p] } = await pool.query(`SELECT id FROM profile WHERE user_id = $1`, [userId]);
  const profileId = p?.id || null;
  const { rows: s } = await pool.query(`SELECT id FROM searches WHERE profile_id = $1`, [profileId]);
  const { rows: a } = await pool.query(`SELECT id FROM applications WHERE profile_id = $1`, [profileId]);
  return { users: [userId], profile: profileId ? [profileId] : [], searches: s.map((r) => r.id), applications: a.map((r) => r.id) };
}

// Never handed out, even to the owner: secrets are encrypted for the
// server, and a hash is not their password.
const DOLD = /(_enc$|^password_hash$|^auth_id$|embedding$)/;

function rensa(rad) {
  const ut = {};
  for (const [k, v] of Object.entries(rad)) {
    if (DOLD.test(k)) continue;
    // Files are named, not inlined: a CV is downloaded from the app.
    ut[k] = Buffer.isBuffer(v) ? `[fil, ${v.length} byte]` : v;
  }
  return ut;
}

// ------------------------------------------------------------
// Export: the account, the profile, and every row anywhere that points
// at them, as one JSON document.
// ------------------------------------------------------------
export async function exportera(userId) {
  const ids = await användarensId(userId);
  const ut = {
    exporterad: new Date().toISOString(),
    om: 'Allt Jobbflo har sparat om dig. Krypterade lösenord och nycklar ingår inte; filer anges med storlek.',
    konto: null,
    profil: null,
  };
  const { rows: [u] } = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  ut.konto = u ? rensa(u) : null;
  if (ids.profile.length) {
    const { rows: [p] } = await pool.query(`SELECT * FROM profile WHERE id = $1`, [ids.profile[0]]);
    ut.profil = rensa(p);
  }
  for (const { tabell, kolumn, mot } of await nycklarTillAnvändaren()) {
    if (tabell === 'profile' || !ids[mot].length) continue;
    const { rows } = await pool.query(
      `SELECT * FROM public."${tabell}" WHERE "${kolumn}" = ANY($1::uuid[])`, [ids[mot]]);
    if (!rows.length) continue;
    const nyckel = tabell;
    // One table can point at the user two ways (attachments by profile
    // and by search); a row is listed once.
    const sedda = new Set((ut[nyckel] || []).map((r) => r.id));
    ut[nyckel] = [...(ut[nyckel] || []), ...rows.filter((r) => !r.id || !sedda.has(r.id)).map(rensa)];
  }
  return ut;
}

// ------------------------------------------------------------
// Erasure. One transaction: what only points at the user loosely (a log
// line set to NULL would keep its text) goes first, then the account —
// and everything else cascades from it. Cost rows (llm_usage) keep their
// numbers with no owner: tokens and dollars, nothing of the person.
//
// The Supabase login goes last, outside the transaction: if that call
// fails the person's data is still gone, and signing in again would
// only make a new, empty account.
// ------------------------------------------------------------
export async function raderaKonto(userId) {
  const ids = await användarensId(userId);
  const { rows: [u] } = await pool.query(`SELECT auth_id FROM users WHERE id = $1`, [userId]);
  if (!u) throw Object.assign(new Error('kontot finns inte'), { status: 404 });

  const klient = await pool.connect();
  try {
    await klient.query('BEGIN');
    await klient.query(
      `DELETE FROM auto_apply_log WHERE search_id = ANY($1::uuid[]) OR application_id = ANY($2::uuid[])`,
      [ids.searches, ids.applications]);
    await klient.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await klient.query('COMMIT');
  } catch (err) {
    await klient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    klient.release();
  }

  let inloggningBorta = true;
  if (u.auth_id && inloggningsläge() === 'supabase') {
    const { error } = await supabaseAdmin().auth.admin.deleteUser(u.auth_id).catch((e) => ({ error: e }));
    if (error) {
      inloggningBorta = false;
      console.error(`konto raderat men inte Supabase-användaren ${u.auth_id}: ${error.message}`);
    }
  }
  return { raderat: true, inloggningBorta };
}
