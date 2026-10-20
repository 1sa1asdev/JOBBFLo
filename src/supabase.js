import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { pool } from './db.js';
import { encryptSecret } from './secrets.js';
import { supabaseUrl, supabaseAnonKey } from './authMode.js';

// ------------------------------------------------------------
// Supabase Auth on the server: whose session this request carries, and
// the account and profile that session belongs to.
//
// Supabase only signs people in. Everything else — the account row,
// the profile, every user's data — stays in our own tables, reached by
// the server alone (RLS shuts the Data API out, migration 053). A
// Supabase user is tied to our users row by users.auth_id.
// ------------------------------------------------------------

// The request's session, read from (and refreshed into) its cookies.
// setAll throws inside a server component, where cookies are read-only;
// the middleware refreshes them there instead, so that is safe to drop.
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (lista) => {
        try {
          for (const { name, value, options } of lista) store.set(name, value, options);
        } catch { /* server component — the middleware refreshes instead */ }
      },
    },
  });
}

// The service key: deleting an account's Supabase user. Server only,
// never sent anywhere near a browser.
export function supabaseAdmin() {
  const nyckel = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!nyckel) throw new Error('SUPABASE_SERVICE_ROLE_KEY saknas');
  return createClient(supabaseUrl(), nyckel, { auth: { persistSession: false, autoRefreshToken: false } });
}

// The signed-in Supabase user's id (the JWT's sub), or null.
export async function supabaseAnvändarId() {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return data.claims.sub;
}

// ------------------------------------------------------------
// Our account for a Supabase user, made the first time they sign in.
//
// In order:
//   1. already linked by auth_id                       → that account
//   2. an account with the same VERIFIED email and no
//      Supabase user yet (a restored local account)    → linked to it
//   3. otherwise a new account; a profile with the same
//      email and no owner (seeded or restored) is
//      claimed, else a new profile is made
//
// Email is trusted only when Supabase says it is confirmed — Google
// accounts are, and an email link confirms by being clicked. An
// unconfirmed address claiming someone's restored profile would be
// account takeover by typing an address.
//
// providerRefreshToken: Google's, handed over once at sign-in and never
// again (Supabase does not keep it). Stored encrypted for the Gmail API.
// ------------------------------------------------------------
export async function kontoFörSupabase(user, { providerRefreshToken = null } = {}) {
  if (!user?.id) throw new Error('kontoFörSupabase: ingen Supabase-användare');
  const email = String(user.email || '').trim().toLowerCase();
  const bekräftad = Boolean(user.email_confirmed_at || user.confirmed_at);
  const namn = user.user_metadata?.full_name || user.user_metadata?.name
    || (email ? email.split('@')[0] : 'Ny användare');

  const klient = await pool.connect();
  try {
    await klient.query('BEGIN');
    let { rows: [konto] } = await klient.query(
      `SELECT id FROM users WHERE auth_id = $1`, [user.id]);

    if (!konto && email && bekräftad) {
      ({ rows: [konto] } = await klient.query(
        `UPDATE users SET auth_id = $1 WHERE lower(email) = $2 AND auth_id IS NULL RETURNING id`,
        [user.id, email]));
    }
    if (!konto) {
      if (!email) throw new Error('Google-kontot saknar e-postadress');
      ({ rows: [konto] } = await klient.query(
        `INSERT INTO users (email, auth_id) VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING RETURNING id`, [email, user.id]));
      // The address is taken by an account that is already linked to
      // another Supabase user, or by one we may not link (unconfirmed).
      if (!konto) throw Object.assign(new Error('det finns redan ett konto med den adressen'), { status: 409 });
    }

    let { rows: [profil] } = await klient.query(
      `SELECT id FROM profile WHERE user_id = $1`, [konto.id]);
    if (!profil && email && bekräftad) {
      ({ rows: [profil] } = await klient.query(
        // One profile, the oldest: profile.user_id is unique, and two
        // ownerless profiles with one address would both match.
        `UPDATE profile SET user_id = $1, updated_at = now()
         WHERE id = (SELECT id FROM profile WHERE user_id IS NULL AND lower(email) = $2
                     ORDER BY created_at LIMIT 1)
         RETURNING id`, [konto.id, email]));
    }
    if (!profil) {
      ({ rows: [profil] } = await klient.query(
        `INSERT INTO profile (user_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
        [konto.id, namn, email]));
    }
    if (providerRefreshToken) {
      await klient.query(
        `UPDATE profile SET google_refresh_token_enc = $2, updated_at = now() WHERE id = $1`,
        [profil.id, encryptSecret(providerRefreshToken)]);
    }
    await klient.query('COMMIT');
    return { userId: konto.id, profileId: profil.id };
  } catch (err) {
    await klient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    klient.release();
  }
}
