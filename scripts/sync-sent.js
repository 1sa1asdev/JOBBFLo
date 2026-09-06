// One pass of the Sent-folder sync the IMAP loop now runs on a timer.
// Useful after adding the feature, or when the worker has been down.
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { pool } from '../src/db.js';
import { catchUpSent } from '../src/imap.js';

const c = new ImapFlow({
  host: 'imap.gmail.com', port: 993, secure: true,
  auth: {
    user: process.env.GMAIL_USER?.trim(),
    pass: process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, ''),
  },
  logger: false,
});

await c.connect();
await catchUpSent(c);
await c.logout();
await pool.end();
