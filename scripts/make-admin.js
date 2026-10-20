// Makes an account the operator (users.role = 'admin'), or takes it back.
//
//   node scripts/make-admin.js <e-post>
//   node scripts/make-admin.js <e-post> --ta-bort
//
// By hand on purpose: nothing in the app can grant it, so no route can
// be talked into it. The account must exist — sign in once first.
import 'dotenv/config';
import { pool } from '../src/db.js';

const [email, flagga] = process.argv.slice(2);
if (!email) {
  console.error('användning: node scripts/make-admin.js <e-post> [--ta-bort]');
  process.exit(1);
}
const roll = flagga === '--ta-bort' ? 'user' : 'admin';
const { rows: [u] } = await pool.query(
  `UPDATE users SET role = $2 WHERE lower(email) = lower($1) RETURNING email, role`, [email.trim(), roll]);
await pool.end();
if (!u) {
  console.error(`inget konto med adressen ${email} — logga in en gång först`);
  process.exit(1);
}
console.log(`✓ ${u.email} är nu ${u.role === 'admin' ? 'admin' : 'vanlig användare'}`);
