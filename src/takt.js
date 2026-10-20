import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { pool } from './db.js';

// ------------------------------------------------------------
// How often a route may be called, per user or per address.
//
// Only where it matters: guessing passwords, opening Gmail connections
// on someone's account, the platform's paid embeddings, heavy exports.
// Everything that spends a user's own AI budget is held by that budget.
//
// Fixed windows in Postgres (rate_limits): Vercel runs many instances
// that share nothing but the database.
// ------------------------------------------------------------
export const GRÄNSER = {
  inloggning: { max: 20, sekunder: 600 },      // per address: password guesses
  callback: { max: 30, sekunder: 600 },        // per address: sign-in returns
  hämtaPost: { max: 30, sekunder: 600 },       // per user: a Gmail connection each
  gmailTest: { max: 10, sekunder: 3600 },      // per user: Google locks accounts that fail often
  filterförslag: { max: 120, sekunder: 3600 }, // per user: the platform's embedding key
  export: { max: 10, sekunder: 3600 },         // per user: a walk of every table
};

// The caller's address, as the host reports it. Vercel sets these and
// overwrites what a client sends; without them (a local server) there
// is no address to limit by, and the address limits are skipped.
export async function klientAdress() {
  const h = await headers();
  return h.get('x-real-ip') || h.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

// true while within the limit. Counts this call either way.
export async function inomTakt(namn, vem) {
  if (!vem) return true;
  const { max, sekunder } = GRÄNSER[namn];
  const fönster = new Date(Math.floor(Date.now() / (sekunder * 1000)) * sekunder * 1000);
  const { rows: [r] } = await pool.query(
    `INSERT INTO rate_limits (nyckel, fönster, antal) VALUES ($1, $2, 1)
     ON CONFLICT (nyckel, fönster) DO UPDATE SET antal = rate_limits.antal + 1
     RETURNING antal`, [`${namn}:${vem}`, fönster]);
  // Now and then, the windows nobody will ask about again.
  if (Math.random() < 0.01) {
    pool.query(`DELETE FROM rate_limits WHERE fönster < now() - interval '1 day'`).catch(() => {});
  }
  return r.antal <= max;
}

export const förMånga = (text = 'För många försök — vänta en stund och försök igen.') =>
  NextResponse.json({ error: text }, { status: 429, headers: { 'retry-after': '600' } });
