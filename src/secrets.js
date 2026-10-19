import 'dotenv/config';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// ------------------------------------------------------------
// AES-256-GCM for users' keys and passwords stored in Postgres —
// LLM API keys and Gmail app passwords. Rotating the secret
// invalidates what is stored (users re-enter it) rather than
// exposing it.
//
// ENCRYPTION_KEY is the platform's own setting for this. It used to be
// derived from AUTH_SECRET, which signed sessions — and once Supabase
// handles login, AUTH_SECRET has nothing left to do with sessions. It
// stays as the fallback so values already encrypted under it (and
// under the development key, locally) can still be read.
// ------------------------------------------------------------

function key() {
  const secret = process.env.ENCRYPTION_KEY
    || process.env.AUTH_SECRET
    || (process.env.NODE_ENV === 'production' ? null : 'dev-secret-not-for-production');
  if (!secret) throw new Error('ENCRYPTION_KEY krävs för att kryptera användares nycklar och lösenord');
  return scryptSync(secret, 'jobbflo-secrets-v1', 32);
}

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(stored) {
  if (!stored) return null;
  try {
    const [v, iv, tag, data] = stored.split('.');
    if (v !== 'v1') return null;
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // wrong secret or tampered — treat as "no key configured"
  }
}

// never send a key back to the browser; show shape only
export function maskSecret(plain) {
  if (!plain) return null;
  if (plain.length <= 10) return `${plain.slice(0, 2)}…`;
  return `${plain.slice(0, 6)}…${plain.slice(-4)}`;
}
