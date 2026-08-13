import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { pool } from './db.js';
import { classifyReply, draftReply, generateInterviewPrep } from './classify.js';

// ------------------------------------------------------------
// IMAP IDLE loop. The reconnect wrapper matters more than any
// optimization above it — a silently dropped IDLE connection is
// what actually blows the 15–30s latency budget.
//
// Catch-up: on every (re)connect we fetch everything since
// last_seen_uid before going back to IDLE, so nothing is lost
// while we were down.
// ------------------------------------------------------------

const MAILBOX = 'INBOX';

function client() {
  const user = process.env.GMAIL_USER?.trim();
  // strip Google's display spaces from the app password (see mailer.js)
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
}

async function getState() {
  const { rows: [s] } = await pool.query(
    `SELECT * FROM imap_state WHERE mailbox = $1`, [MAILBOX]
  );
  return s || null;
}

async function setState(uidValidity, lastSeenUid) {
  await pool.query(
    `INSERT INTO imap_state (mailbox, uid_validity, last_seen_uid, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (mailbox) DO UPDATE SET
       uid_validity = EXCLUDED.uid_validity,
       last_seen_uid = GREATEST(imap_state.last_seen_uid, EXCLUDED.last_seen_uid),
       updated_at = now()`,
    [MAILBOX, uidValidity, lastSeenUid]
  );
}

// ------------------------------------------------------------
// Reply matching — employers don't behave. Resolution order:
// 1. In-Reply-To matches a stored message_id     → confident
// 2. Last References entry matches               → confident
// 3. Sender DOMAIN matches, ≤90 days, exactly
//    one open application                        → probable (inferred)
// 4. Domain matches multiple open applications   → don't guess
// 5. No match                                    → leave in inbox
// ------------------------------------------------------------
const OPEN_STATUSES = `('sent','replied','interview')`;

async function findByMessageId(msgId) {
  if (!msgId) return null;
  const { rows } = await pool.query(
    `SELECT id FROM applications WHERE message_id = $1
     UNION
     SELECT application_id AS id FROM email_messages WHERE message_id = $1 AND direction = 'outbound'`,
    [msgId]
  );
  return rows[0]?.id || null;
}

export async function matchReply({ inReplyTo, references, fromAddr }) {
  // 1. In-Reply-To
  let appId = await findByMessageId(inReplyTo);
  if (appId) return { applicationId: appId, inferred: false };

  // 2. last References entry
  const lastRef = references?.length ? references[references.length - 1] : null;
  appId = await findByMessageId(lastRef);
  if (appId) return { applicationId: appId, inferred: false };

  // 3/4. domain match — anna.lindqvist@ replying when we wrote to jobb@
  const domain = fromAddr?.split('@')[1]?.toLowerCase();
  if (!domain || /gmail\.com|hotmail\.|outlook\.|yahoo\./.test(domain)) {
    return { applicationId: null, inferred: false };
  }
  const { rows } = await pool.query(
    `SELECT id FROM applications
     WHERE status IN ${OPEN_STATUSES}
       AND sent_at > now() - interval '90 days'
       AND lower(split_part(sent_to, '@', 2)) = $1`,
    [domain]
  );
  if (rows.length === 1) return { applicationId: rows[0].id, inferred: true };
  if (rows.length > 1) {
    console.log(`  ?? ${fromAddr}: domain matches ${rows.length} open applications — not guessing`);
  }
  return { applicationId: null, inferred: false };
}

// ------------------------------------------------------------
// Handle one inbound message. Notify (store) BEFORE classifying —
// the status badge should never wait on the LLM.
// ------------------------------------------------------------
async function handleMessage(parsed, uid) {
  const fromAddr = parsed.from?.value?.[0]?.address || '';
  const fromName = parsed.from?.value?.[0]?.name || null;
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references ? [parsed.references] : [];

  // ignore our own sent mail showing up in All Mail / self-tests
  if (fromAddr.toLowerCase() === (process.env.GMAIL_USER || '').toLowerCase()) return;

  const { applicationId, inferred } = await matchReply({
    inReplyTo: parsed.inReplyTo,
    references,
    fromAddr,
  });

  if (!applicationId) {
    console.log(`  -- ${fromAddr} "${parsed.subject}" — no application match, leaving in inbox`);
    return;
  }

  // dedupe on message-id
  if (parsed.messageId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM email_messages WHERE message_id = $1`, [parsed.messageId]
    );
    if (rows.length) return;
  }

  const body = (parsed.text || '').trim() || parsed.html || '';

  const { rows: [email] } = await pool.query(
    `INSERT INTO email_messages (application_id, direction, message_id, in_reply_to, references_ids,
       from_addr, from_name, to_addr, subject, body_text, imap_uid, sent_at)
     VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [applicationId, parsed.messageId || null, parsed.inReplyTo || null, references,
     fromAddr, fromName, parsed.to?.text || null, parsed.subject || null, body,
     uid, parsed.date || new Date()]
  );
  console.log(`  ← ${fromAddr} "${parsed.subject}"${inferred ? ' (inferred via domän)' : ''}`);

  // fast classify → status flips within ~1s of storage
  try {
    const cls = await classifyReply(body, { subject: parsed.subject });
    await pool.query(
      `UPDATE applications SET status = $2, updated_at = now()
       WHERE id = $1 AND status IN ${OPEN_STATUSES}`,
      [applicationId, cls.status]
    );
    console.log(`    status → ${cls.status}: ${cls.summary}`);

    // slower work after the badge is out
    if (cls.status === 'interview') {
      await generateInterviewPrep(applicationId).catch((e) => console.error('prep:', e.message));
    }
    if (cls.status !== 'rejected') {
      await draftReply(applicationId, email.id).catch((e) => console.error('draft:', e.message));
    }
  } catch (err) {
    console.error(`    classify failed: ${err.message}`);
  }
}

async function catchUp(imap) {
  const box = await imap.mailboxOpen(MAILBOX);
  const state = await getState();

  let sinceUid = 0;
  if (state && Number(state.uid_validity) === Number(box.uidValidity)) {
    sinceUid = Number(state.last_seen_uid);
  } // uidValidity changed → UIDs reset, refetch recent window only

  const range = sinceUid > 0 ? `${sinceUid + 1}:*` : `${Math.max(1, box.exists - 20)}:*`;
  let maxUid = sinceUid;

  for await (const msg of imap.fetch(range, { uid: true, source: true }, { uid: sinceUid > 0 })) {
    if (msg.uid <= sinceUid) continue;
    const parsed = await simpleParser(msg.source);
    await handleMessage(parsed, msg.uid).catch((e) => console.error('handle:', e.message));
    maxUid = Math.max(maxUid, msg.uid);
  }

  await setState(box.uidValidity, maxUid);
}

// ------------------------------------------------------------
// The loop: connect → catch up → IDLE. Any error tears the
// connection down and we come back with exponential backoff.
// 'exists' fires when new mail arrives during IDLE.
// ------------------------------------------------------------
export async function runImapLoop({ signal } = {}) {
  let backoff = 2000;
  while (!signal?.aborted) {
    const imap = client();
    try {
      await imap.connect();
      console.log('imap: connected');
      backoff = 2000;

      await catchUp(imap);

      imap.on('exists', async () => {
        try { await catchUp(imap); } catch (e) { console.error('imap catchup:', e.message); }
      });

      // imapflow keeps IDLE alive internally; block until the connection dies
      await new Promise((resolve, reject) => {
        imap.on('close', resolve);
        imap.on('error', reject);
        signal?.addEventListener('abort', () => imap.logout().catch(() => {}), { once: true });
      });
      console.log('imap: connection closed');
    } catch (err) {
      console.error('imap:', err.message);
      try { await imap.logout(); } catch { /* already gone */ }
    }
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 60_000);
  }
}
