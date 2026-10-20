// One pass of the Sent-folder sync each user's mailbox runs on a timer.
// Useful when the worker has been down.
//
//   node scripts/sync-sent.js [profil-id]
//
// Without a profile id it uses the only profile, and refuses when there
// are more.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { syncSentNow } from '../src/imap.js';
import { endaProfilId } from '../src/owner.js';

await syncSentNow(process.argv[2] || await endaProfilId());
await pool.end();
