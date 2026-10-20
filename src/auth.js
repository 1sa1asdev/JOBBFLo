import 'dotenv/config';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { cookies } from 'next/headers';
import { pool } from './db.js';
import { NextResponse } from 'next/server';
import { endaProfilId, ägerSökning, ägerAnsökan, ägerFörslag, ägerBilaga, serAnnons } from './owner.js';

// ------------------------------------------------------------
// Accounts. Zero external deps:
//   passwords  — scrypt (N=16384), stored as scrypt$N$salt$hash
//   sessions   — stateless signed cookie "uid.exp.hmac" so the
//                edge middleware can verify without touching
//                Postgres. Logging out clears the cookie.
// ------------------------------------------------------------

export const SESSION_COOKIE = 'jj_session';
const SESSION_DAYS = 30;
const SCRYPT_N = 16384;

function secret() {
  const s = process.env.AUTH_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET måste sättas i produktion');
  }
  return 'dev-secret-not-for-production';
}

// ---------- passwords ----------
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N }).toString('hex');
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, n, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const candidate = scryptSync(password, salt, 64, { N: Number(n) });
    return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

// ---------- session tokens ----------
export function signSession(userId, days = SESSION_DAYS) {
  const exp = Date.now() + days * 86400000;
  const payload = `${userId}.${exp}`;
  const sig = createHmac('sha256', secret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifySession(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expected = createHmac('sha256', secret()).update(`${uid}.${exp}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now()) return null;
  return uid;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  };
}

// ---------- request helpers (API routes / server components) ----------
export async function currentUserId() {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

// Resolve the logged-in user's profile — the scoping anchor for
// every data query. Throws 401-shaped error when not logged in.
export async function currentProfile() {
  const userId = await currentUserId();
  if (!userId) {
    const err = new Error('inte inloggad');
    err.status = 401;
    throw err;
  }
  const { rows: [profile] } = await pool.query(
    `SELECT p.*, u.email AS account_email FROM profile p
     JOIN users u ON u.id = p.user_id WHERE p.user_id = $1`,
    [userId]
  );
  if (!profile) {
    const err = new Error('profil saknas för kontot');
    err.status = 401;
    throw err;
  }
  return profile;
}

// The profile a request acts for — what every route asks instead of
// reading the first row (see src/owner.js for why that was wrong).
//
// Follows the same switch as middleware.js: without AUTH_SECRET there
// are no accounts, the gate is off, and the answer is the one profile
// there is. More than one with the gate off is refused rather than
// guessed. With AUTH_SECRET it is the logged-in user's, and the
// middleware has already turned away requests with no valid session —
// so the 401 here is only a cookie whose account has lost its profile.
export async function aktivProfilId() {
  if (!process.env.AUTH_SECRET) return endaProfilId();
  const userId = await currentUserId();
  if (!userId) {
    const err = new Error('inte inloggad');
    err.status = 401;
    throw err;
  }
  const { rows: [p] } = await pool.query(
    `SELECT id FROM profile WHERE user_id = $1`, [userId]);
  if (!p) {
    const err = new Error('profil saknas för kontot');
    err.status = 401;
    throw err;
  }
  return p.id;
}

// ------------------------------------------------------------
// The row in the URL, if it is the caller's. Each returns the caller's
// profileId when they own the row and null when they do not — which a
// route answers with inteHittad(), the same 404 a row that does not
// exist gets, so nobody learns that someone else's search is there.
// ------------------------------------------------------------
const ägareAv = (kontroll) => async (id) => {
  const profileId = await aktivProfilId();
  return (await kontroll(id, profileId)) ? profileId : null;
};
export const ägareAvSökning = ägareAv(ägerSökning);
export const ägareAvAnsökan = ägareAv(ägerAnsökan);
export const ägareAvFörslag = ägareAv(ägerFörslag);
export const ägareAvBilaga = ägareAv(ägerBilaga);
// For ads it is "may this user see it", not "do they own it": the pool
// is everyone's, a manual ad only its maker's.
export const ägareAvAnnons = ägareAv(serAnnons);

export const inteHittad = (vad = 'finns inte') => NextResponse.json({ error: vad }, { status: 404 });
