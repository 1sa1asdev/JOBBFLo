// Compares Gmail's INBOX with what the app stored, and says which of
// the three reasons applies to each message it is missing:
//
//   ingen träff   — matchReply could not tie it to an application
//   förbi kursorn — its UID is below last_seen_uid, so catch-up skipped it
//   okänt         — matched and in range, but never stored
//
// Reports only; writes nothing.
//
//   node scripts/check-inbox.js [dagar] [profil-id]
//
// One user's mailbox, read with that user's stored credentials. Without
// a profile id it uses the only profile, and refuses when there are more.
import 'dotenv/config';
import { simpleParser } from 'mailparser';
import { pool } from '../src/db.js';
import { matchReply, läsposition } from '../src/imap.js';
import { gmailFör, imapKlient } from '../src/credentials.js';
import { endaProfilId } from '../src/owner.js';

const days = Number(process.argv[2] || 7);
const profileId = process.argv[3] || await endaProfilId();
const gmail = await gmailFör(profileId);
const c = imapKlient(gmail);

await c.connect();
const lock = await c.getMailboxLock('INBOX', { readOnly: true });

const state = await läsposition(profileId, 'INBOX');
console.log(`kursor: uid ${state?.last_seen_uid} (uidValidity ${state?.uid_validity}), `
  + `brevlådan har uidValidity ${c.mailbox.uidValidity}, ${c.mailbox.exists} brev\n`);

const since = new Date(Date.now() - days * 86400000);
const uids = await c.search({ since }, { uid: true }) || [];
console.log(`${uids.length} brev i INBOX de senaste ${days} dygnen\n`);

let lagrade = 0; const saknade = [];
for await (const msg of c.fetch(uids, { uid: true, source: true }, { uid: true })) {
  const p = await simpleParser(msg.source);
  const from = p.from?.value?.[0]?.address || '';
  if (from.toLowerCase() === gmail.user.toLowerCase()) continue;

  const { rows: [känd] } = await pool.query(
    `SELECT 1 FROM email_messages m JOIN applications a ON a.id = m.application_id
     WHERE m.message_id = $1 AND a.profile_id = $2`, [p.messageId, profileId]);
  if (känd) { lagrade += 1; continue; }

  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  const { applicationId } = await matchReply({
    inReplyTo: p.inReplyTo, references: refs, fromAddr: from, profileId });

  saknade.push({
    uid: msg.uid,
    from,
    subject: String(p.subject || '').slice(0, 42),
    orsak: !applicationId ? 'ingen träff'
      : msg.uid <= Number(state?.last_seen_uid || 0) ? 'förbi kursorn'
        : 'okänt',
  });
}

console.log(`${lagrade} redan i appen, ${saknade.length} saknas\n`);
for (const s of saknade) {
  console.log(`  uid ${String(s.uid).padEnd(6)} ${s.orsak.padEnd(14)} `
    + `${s.from.padEnd(34)} ${s.subject}`);
}

lock.release();
await c.logout();
await pool.end();
