// Looks for replies the user wrote in Gmail, by asking the server for
// the threads this app already knows about — one IMAP SEARCH per
// application, rather than reading through the Sent folder.
//
// Reports only; writes nothing. Run it when a reply sent from Gmail is
// not showing up on an application.
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { pool } from '../src/db.js';

const c = new ImapFlow({
  host: 'imap.gmail.com', port: 993, secure: true,
  auth: {
    user: process.env.GMAIL_USER?.trim(),
    pass: process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, ''),
  },
  logger: false,
});

await c.connect();
const boxes = await c.list();
const sent = boxes.find((b) => b.specialUse === '\\Sent')
  || boxes.find((b) => /^\[Gmail\]\/(Sent Mail|Skickat)$/i.test(b.path));
console.log('Skickat-mappen:', sent ? sent.path : 'HITTADES INTE');

const { rows: trådar } = await pool.query(
  `SELECT a.id, a.message_id, a.sent_to, a.sent_at, ads.employer
   FROM applications a JOIN ads ON ads.id = a.ad_id
   WHERE a.message_id IS NOT NULL AND a.sent_to IS NOT NULL
     AND a.status IN ('sent','replied','interview')
     AND a.sent_at > now() - interval '90 days'
     AND EXISTS (SELECT 1 FROM email_messages m
                 WHERE m.application_id = a.id AND m.direction = 'inbound')
     AND NOT EXISTS (SELECT 1 FROM email_messages m
                     WHERE m.application_id = a.id AND m.direction = 'outbound'
                       AND m.message_id IS DISTINCT FROM a.message_id)
   ORDER BY a.sent_at DESC LIMIT 50`
);
console.log(`${trådar.length} öppna trådar att slå upp\n`);

if (sent) {
  const lock = await c.getMailboxLock(sent.path, { readOnly: true });
  let hittade = 0; let saknas = 0;

  for (const t of trådar) {
    const uids = await c.search({ to: t.sent_to, since: new Date(t.sent_at) }, { uid: true }) || [];
    if (!uids.length) continue;

    for await (const msg of c.fetch(uids, { uid: true, source: true }, { uid: true })) {
      const p = await simpleParser(msg.source);
      if (p.messageId === t.message_id) continue;   // vårt eget utskick
      hittade += 1;
      const { rows: [känd] } = await pool.query(
        `SELECT 1 FROM email_messages WHERE message_id = $1`, [p.messageId]);
      if (!känd) saknas += 1;
      console.log(`  ${String(t.employer).slice(0, 24).padEnd(26)}`
        + `${String(p.subject).slice(0, 38).padEnd(40)}`
        + (känd ? 'redan i appen' : 'SAKNAS i appen'));
    }
  }
  console.log(`\n${hittade} egna svar i trådarna, varav ${saknas} saknas i appen`);
  lock.release();
}

await c.logout();
await pool.end();
