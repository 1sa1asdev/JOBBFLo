// ------------------------------------------------------------
// How people sign in. Three modes, decided by what the host has set —
// read at runtime, so one build serves all three:
//
//   supabase  SUPABASE_URL + SUPABASE_ANON_KEY. Google login through
//             Supabase Auth: the hosted app.
//   lösenord  AUTH_SECRET. Our own email + password accounts and signed
//             cookie: CI (prove-owner-checks) and local testing of
//             several users without a Supabase stack.
//   av        Neither. No login at all — one person on their own
//             machine. Refused in production: a deploy that forgot its
//             auth settings must not serve the one profile to anyone.
//
// No node: imports — the middleware runs this on the edge.
// ------------------------------------------------------------
export function inloggningsläge() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) return 'supabase';
  if (process.env.AUTH_SECRET) return 'lösenord';
  return 'av';
}

// A production server with no login is a misconfiguration, except when
// someone runs a production build on their own machine on purpose.
export function utanInloggningTillåtet() {
  return process.env.NODE_ENV !== 'production' || process.env.JOBBFLO_UTAN_INLOGGNING === '1';
}

export const supabaseUrl = () => process.env.SUPABASE_URL;
export const supabaseAnonKey = () => process.env.SUPABASE_ANON_KEY;
