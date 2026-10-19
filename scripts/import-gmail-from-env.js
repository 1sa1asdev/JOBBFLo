// One-time move: the Gmail app password from .env into the profile.
//
//   node scripts/import-gmail-from-env.js
//
// Before per-user credentials, GMAIL_USER and GMAIL_APP_PASSWORD in .env
// were how the app sent and read mail. No code reads them any more — the
// password lives encrypted on the profile, the same as for any user who
// enters it under Profil → Gmail. This copies an existing setup over so
// a local install keeps working, then the .env lines are simply unused.
//
// It tests the login against both sending and reading first, and saves
// nothing if either fails. Single-profile installs only: with several
// profiles there is no telling whose password this is.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { endaProfilId } from '../src/owner.js';
import { encryptSecret } from '../src/secrets.js';
import { testaGmail, städaLösenord } from '../src/credentials.js';

try {
  const pass = städaLösenord(process.env.GMAIL_APP_PASSWORD);
  if (!pass) throw new Error('GMAIL_APP_PASSWORD finns inte i .env — inget att flytta.');

  const profileId = await endaProfilId();
  const { rows: [p] } = await pool.query(`SELECT email FROM profile WHERE id = $1`, [profileId]);
  const envUser = process.env.GMAIL_USER?.trim().toLowerCase();
  if (envUser && envUser !== p.email?.trim().toLowerCase()) {
    // The sender is always the profile's own address; a password for a
    // different account would log in fine and then send as the wrong one.
    throw new Error('GMAIL_USER i .env är inte profilens mejladress. Ändra adressen under Profil först.');
  }

  console.log(`testar inloggning för ${p.email} …`);
  const test = await testaGmail({ user: p.email, pass });
  console.log(`  sändning: ${test.smtp.ok ? 'ok' : test.smtp.fel}`);
  console.log(`  läsning:  ${test.imap.ok ? 'ok' : test.imap.fel}`);
  if (!test.ok) throw new Error('inloggningen misslyckades — inget sparades.');

  await pool.query(
    `UPDATE profile SET gmail_app_password_enc = $2, gmail_verified_at = now(), updated_at = now()
     WHERE id = $1`, [profileId, encryptSecret(pass)]);
  console.log('✓ applösenordet är sparat krypterat i profilen. GMAIL_* i .env används inte längre.');
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
