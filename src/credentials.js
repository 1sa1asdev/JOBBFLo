import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { pool } from './db.js';
import { decryptSecret } from './secrets.js';

// ------------------------------------------------------------
// A user's Gmail credentials — whose mail, read from their profile.
//
// These lived in .env as GMAIL_USER and GMAIL_APP_PASSWORD, which works
// for one person on one machine. Now each user enters an app password
// after signing up; it is stored encrypted on their profile, and every
// send and every IMAP login asks for a specific profile's credentials.
//
// There is deliberately no fallback to the environment. A fallback is
// how one user's mail ends up going out through another's account, and
// a missing password is a thing to tell the user about, not to paper
// over with whatever the server happens to have.
//
// The address is profile.email: the sender is always the user, the
// account they sign in with.
// ------------------------------------------------------------

export class GmailSaknasError extends Error {
  constructor() {
    super('Gmail är inte kopplat — lägg in ett applösenord under Profil.');
    this.code = 'GMAIL_SAKNAS';
    this.status = 409;
  }
}

// Google shows app passwords as "abcd efgh ijkl mnop"; the spaces are
// display formatting only and must not be sent.
export const städaLösenord = (lösen) => String(lösen || '').replace(/\s+/g, '');

export async function gmailFör(profileId) {
  if (!profileId) throw new Error('gmailFör: profileId krävs');
  const { rows: [p] } = await pool.query(
    `SELECT email, gmail_app_password_enc FROM profile WHERE id = $1`, [profileId]);
  if (!p) throw new Error('profilen finns inte');
  const user = p.email?.trim();
  const pass = städaLösenord(decryptSecret(p.gmail_app_password_enc));
  if (!user || !pass) throw new GmailSaknasError();
  return { user, pass };
}

export function smtpTransport({ user, pass }) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

export function imapKlient({ user, pass }) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
}

// ------------------------------------------------------------
// Try both halves before anything is saved.
//
// Sending and reading are separate logins against separate servers, and
// a password that works for one does not prove the other — so both are
// tried, and the answer says which failed and why in words the user can
// act on. A raw "535-5.7.8 Username and Password not accepted" is the
// message that makes people give up.
// ------------------------------------------------------------
function förklara(err, del) {
  const text = `${err?.response || ''} ${err?.message || ''} ${err?.serverResponseCode || ''}`;
  if (/535|AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted|authentication failed/i.test(text)) {
    return 'Fel lösenord. Kontrollera att du kopierat applösenordet (16 tecken), inte ditt vanliga Google-lösenord.';
  }
  if (/Application-specific password required|534/i.test(text)) {
    return 'Google kräver ett applösenord. Ditt vanliga lösenord fungerar inte här.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|ECONNRESET/i.test(text)) {
    return `Kunde inte nå Gmail (${del}). Kontrollera internetanslutningen och försök igen.`;
  }
  return `${del}: ${err?.message || 'okänt fel'}`;
}

const medTidsgräns = (löfte, ms, vad) => Promise.race([
  löfte,
  new Promise((_, nej) => setTimeout(() => nej(new Error(`timeout (${vad})`)), ms)),
]);

export async function testaGmail({ user, pass }) {
  const cred = { user: String(user || '').trim(), pass: städaLösenord(pass) };
  if (!cred.user) return { ok: false, smtp: null, imap: null, fel: 'Profilen saknar mejladress.' };
  if (!cred.pass) return { ok: false, smtp: null, imap: null, fel: 'Inget lösenord angivet.' };

  let smtp = null;
  try {
    await medTidsgräns(smtpTransport(cred).verify(), 20_000, 'sändning');
    smtp = { ok: true };
  } catch (err) {
    smtp = { ok: false, fel: förklara(err, 'sändning') };
  }

  let imap = null;
  const klient = imapKlient(cred);
  try {
    await medTidsgräns(klient.connect(), 20_000, 'läsning');
    imap = { ok: true };
  } catch (err) {
    imap = { ok: false, fel: förklara(err, 'läsning') };
  } finally {
    await klient.logout().catch(() => {});
  }

  const ok = smtp.ok && imap.ok;
  return { ok, smtp, imap, fel: ok ? null : (smtp.fel || imap.fel) };
}
