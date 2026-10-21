import { simpleParser } from 'mailparser';
import { pool } from './db.js';
import { gmailFör, imapKlient, GmailSaknasError } from './credentials.js';
import { glömAdress } from './addresses.js';
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

// ------------------------------------------------------------
// Whose mailbox. Every function below works for exactly one user — the
// owner of the mailbox it is reading — and is handed that owner rather
// than finding one. There is no "current user" anywhere in this file:
// the worker runs one mailbox per user (src/imapManager.js), and a
// message read from A's mailbox can only ever touch A's rows.
//
// Only what the user started through the app is read. A mailbox's
// first pass begins at the user's first letter sent from here, and
// nothing older is fetched at all.
// ------------------------------------------------------------
async function ägareFör(profileId) {
  if (!profileId) throw new Error('brevlådan saknar ägare');
  const { user, pass } = await gmailFör(profileId);
  return { profileId, user, pass };
}

const kräverÄgare = (profileId, vad) => {
  if (!profileId) throw new Error(`${vad}: brevlådans ägare krävs`);
};

export async function läsposition(profileId, mailbox = MAILBOX) {
  const { rows: [s] } = await pool.query(
    `SELECT * FROM imap_state WHERE profile_id = $1 AND mailbox = $2`, [profileId, mailbox]
  );
  return s || null;
}

export async function sparaLäsposition(profileId, mailbox, uidValidity, lastSeenUid) {
  await pool.query(
    `INSERT INTO imap_state (profile_id, mailbox, uid_validity, last_seen_uid, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (profile_id, mailbox) DO UPDATE SET
       uid_validity = EXCLUDED.uid_validity,
       -- a new uidValidity renumbers the mailbox, so the old position
       -- means nothing; otherwise it only ever moves forward
       last_seen_uid = CASE WHEN imap_state.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
                            THEN EXCLUDED.last_seen_uid
                            ELSE GREATEST(imap_state.last_seen_uid, EXCLUDED.last_seen_uid) END,
       updated_at = now()`,
    [profileId, mailbox, uidValidity, lastSeenUid]
  );
}

// When this user's mail starts being the app's business: their first
// letter sent from here (or handed to Gmail and not yet recorded). Null
// means they have sent nothing, and then there is nothing to read.
export async function förstaBrevet(profileId) {
  const { rows: [r] } = await pool.query(
    `SELECT LEAST(min(sent_at), min(sending_since)) AS första
     FROM applications WHERE profile_id = $1`, [profileId]);
  return r?.första || null;
}

// ------------------------------------------------------------
// Reply matching — employers don't behave. Resolution order:
// 1. In-Reply-To matches a stored message_id     → confident
// 2. Last References entry matches               → confident
// 3. Sender DOMAIN matches, ≤90 days, exactly
//    one open application                        → probable (inferred)
// 4. Domain matches multiple open applications   → don't guess
// 5. No match                                    → leave in inbox
//
// Every rung looks only among the mailbox owner's applications. Two
// users writing to the same employer is ordinary — and unscoped, the
// domain rung handed A's reply to B's thread when only B had written
// there, and refused to place it at all when both had. A message id is
// no different: one that belongs to B's thread arriving in A's mailbox
// is not a reason to touch B's thread.
// ------------------------------------------------------------
const OPEN_STATUSES = `('sent','replied','interview')`;

async function findByMessageId(msgId, profileId) {
  if (!msgId) return null;
  const { rows } = await pool.query(
    // Any message id in a thread identifies the thread, whichever way
    // it travelled. Restricting this to outbound was fine while only
    // employer replies came through here — those answer OUR letter. A
    // reply the user writes in Gmail answers the EMPLOYER's message,
    // and that id is stored inbound, so the confident path missed it
    // and fell through to the domain guess, which then refused:
    // "devendra.s.singh@hitachienergy.com: domain matches 7 open
    // applications — not guessing". Correct refusal, wrong question.
    `SELECT id FROM applications WHERE message_id = $1 AND profile_id = $2
     UNION
     SELECT m.application_id AS id FROM email_messages m
     JOIN applications a ON a.id = m.application_id
     WHERE m.message_id = $1 AND a.profile_id = $2`,
    [msgId, profileId]
  );
  return rows[0]?.id || null;
}

export async function matchReply({ inReplyTo, references, fromAddr, profileId }) {
  kräverÄgare(profileId, 'matchReply');
  // 1. In-Reply-To
  let appId = await findByMessageId(inReplyTo, profileId);
  if (appId) return { applicationId: appId, inferred: false };

  // 2. last References entry
  const lastRef = references?.length ? references[references.length - 1] : null;
  appId = await findByMessageId(lastRef, profileId);
  if (appId) return { applicationId: appId, inferred: false };

  // 3/4. domain match — anna.lindqvist@ replying when we wrote to jobb@
  const domain = fromAddr?.split('@')[1]?.toLowerCase();
  if (!domain || /gmail\.com|hotmail\.|outlook\.|yahoo\./.test(domain)) {
    return { applicationId: null, inferred: false };
  }
  const { rows } = await pool.query(
    `SELECT id FROM applications
     WHERE profile_id = $2
       AND status IN ${OPEN_STATUSES}
       AND sent_at > now() - interval '90 days'
       AND lower(split_part(sent_to, '@', 2)) = $1`,
    [domain, profileId]
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
// ------------------------------------------------------------
// Bounces.
//
// Told apart from a real reply by the sender and the subject, not by
// reading the text: a bounce quotes the letter it failed to deliver,
// so a classifier shown the body sees a job application and answers
// about that.
//
// Permanent and temporary are different events. "Failure" means the
// address is wrong and the ad should lose it; "Delay" means the
// receiving server is still trying, and acting on it would throw away
// a working address because someone's mail queue was busy for four
// hours. Measured on this inbox: 23 notices, of which 4 were delays.
// ------------------------------------------------------------
const STUDS_AVSÄNDARE = /(mailer-daemon|postmaster|mail-daemon|no-?reply@.*(mailer|bounce))/i;
const STUDS_ÄMNE = /delivery status notification|undelivered mail|mail delivery (failed|subsystem)|returned to sender|delivery has failed|kunde inte levereras/i;
const TILLFÄLLIGT = /\(delay(ed)?\)|delayed|fördröj/i;

export function ärStuds(fromAddr, subject = '', body = '') {
  const avsändare = STUDS_AVSÄNDARE.test(fromAddr || '');
  const ämne = STUDS_ÄMNE.test(subject || '');
  if (!avsändare && !ämne) return null;
  // A delay is reported the same way and means the opposite: nothing is
  // wrong yet. It is recorded as a message and changes nothing.
  if (TILLFÄLLIGT.test(subject || '') || /will retry|försöker igen/i.test(body || '')) {
    return { permanent: false };
  }
  return { permanent: avsändare || ämne };
}

async function hanteraStuds(applicationId, studs, subject) {
  if (!studs.permanent) {
    console.log(`    studs (tillfällig fördröjning) — ingen ändring: ${subject}`);
    return;
  }
  // The status says what happened, and the ad loses the address that
  // did not work — so the lead scanner can look for a real one and the
  // ad becomes a candidate again instead of counting as answered.
  const { rows: [ap] } = await pool.query(
    `UPDATE applications SET status = 'undeliverable', bounced_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ${OPEN_STATUSES}
     RETURNING ad_id, sent_to, profile_id`, [applicationId]);
  if (!ap) {
    console.log('    studs på en ansökan som redan är avslutad — ingen ändring');
    return;
  }
  // The user's own typed-in copy, and the shared one only if that is
  // what bounced.
  const glömd = await glömAdress(ap.ad_id, ap.profile_id, ap.sent_to);
  const rensad = glömd.egen || glömd.delad;
  console.log(`    studs: ${ap.sent_to} kom inte fram`
    + `${rensad ? ' — adressen borttagen från annonsen' : ''}`);
}

// Dedupe on message id, within the owner's threads. The same message can
// legitimately reach two users — an employer writing to both in one
// mail — and each of them gets their copy.
async function redanLagrat(messageId, profileId) {
  if (!messageId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM email_messages m JOIN applications a ON a.id = m.application_id
     WHERE m.message_id = $1 AND a.profile_id = $2 LIMIT 1`, [messageId, profileId]);
  return rows.length > 0;
}

async function handleMessage(parsed, uid, ägare) {
  const fromAddr = parsed.from?.value?.[0]?.address || '';
  const fromName = parsed.from?.value?.[0]?.name || null;
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references ? [parsed.references] : [];

  // ignore our own sent mail showing up in All Mail / self-tests
  if (fromAddr.toLowerCase() === ägare.user.toLowerCase()) return;

  const { applicationId, inferred } = await matchReply({
    inReplyTo: parsed.inReplyTo,
    references,
    fromAddr,
    profileId: ägare.profileId,
  });

  if (!applicationId) {
    console.log(`  -- ${fromAddr} "${parsed.subject}" — no application match, leaving in inbox`);
    return;
  }

  if (await redanLagrat(parsed.messageId, ägare.profileId)) return;

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

  // A bounce is not a reply, and the classifier cannot tell: handed a
  // "Delivery Status Notification (Failure)" it reads the quoted letter
  // underneath and answers "avslag". 19 of 124 rejections were this.
  const studs = ärStuds(fromAddr, parsed.subject, body);
  if (studs) {
    await hanteraStuds(applicationId, studs, parsed.subject);
    return;
  }

  // fast classify → status flips within ~1s of storage
  try {
    // the mailbox owner's key: their mail, their bill
    const cls = await classifyReply(body, {
      subject: parsed.subject, profileId: ägare.profileId, koppling: { applicationId } });
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

// ------------------------------------------------------------
// The user's own replies, sent from Gmail rather than from here.
//
// Answering an employer from your phone is the normal thing to do, and
// until now the app could not see it: the loop reads INBOX, and
// handleMessage drops anything from GMAIL_USER on sight. So a thread
// the user had already answered still showed the employer's message as
// the last word, with a draft waiting under it, and the status never
// moved past 'replied'.
//
// Read as outbound, and matched the same way inbound mail is — except
// the domain fallback keys on the RECIPIENT, since the sender is
// always us.
// ------------------------------------------------------------
async function handleSent(parsed, uid, profileId) {
  const toAddr = parsed.to?.value?.[0]?.address || '';
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references ? [parsed.references] : [];

  // Our own letter, recovered — not a reply the user wrote.
  if (await repareraSending(parsed, toAddr, uid, profileId)) return;

  // Only mail that belongs to a thread this app knows about. Everything
  // else in Sent is the user's own life and none of the app's business.
  const { applicationId } = await matchReply({
    inReplyTo: parsed.inReplyTo,
    references,
    fromAddr: toAddr,
    profileId,
  });
  if (!applicationId) return;

  // The letters this app sent are already stored, with their own
  // message ids — so the copy Gmail keeps in Sent must not become a
  // second row for the same message.
  if (await redanLagrat(parsed.messageId, profileId)) return;

  const body = (parsed.text || '').trim() || parsed.html || '';
  await pool.query(
    `INSERT INTO email_messages (application_id, direction, message_id, in_reply_to,
       references_ids, from_addr, from_name, to_addr, subject, body_text, imap_uid, sent_at)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [applicationId, parsed.messageId || null, parsed.inReplyTo || null, references,
     parsed.from?.value?.[0]?.address || null, parsed.from?.value?.[0]?.name || null,
     toAddr, parsed.subject || null, body, uid, parsed.date || new Date()]
  );

  // A thread the user has answered is not one waiting on them. Only
  // from 'sent', though — an answered interview invitation is still an
  // interview, and overwriting that would lose the better status.
  await pool.query(
    `UPDATE applications SET status = 'replied', updated_at = now()
     WHERE id = $1 AND status = 'sent'`,
    [applicationId]
  );
  console.log(`  → (Gmail) ${toAddr} "${parsed.subject}"`);
}

// Gmail names this folder in the account's own language — Sent Mail,
// Skickat, Gesendet — so it is found by its special-use flag rather
// than by name. Returns null on a server that publishes none, and the
// loop then simply carries on with INBOX.
// ------------------------------------------------------------
// A row in 'sending' is a letter SMTP accepted and the database never
// finished recording: the employer has it, the app does not know its
// message id, and nothing threads to it. The copy Gmail keeps in Sent
// is that missing record — same recipient, written after the claim was
// taken — so finding it here repairs the row instead of leaving a live
// application looking like it never happened.
//
// Note it cannot be matched the normal way: a stuck row has no
// message_id to thread on and no sent_at, so both the id paths and the
// 90-day domain path in matchReply skip it. Hence the explicit lookup,
// and hence it runs before them.
// ------------------------------------------------------------
export async function repareraSending(parsed, toAddr, uid, profileId) {
  kräverÄgare(profileId, 'repareraSending');
  if (!toAddr) return null;
  const när = parsed.date || new Date();
  const { rows: [ap] } = await pool.query(
    // Written after the claim (a minute of clock skew allowed) and
    // within the week — older than that is a row for the reconciler,
    // not a guess made from any message to the same address. And only
    // the mailbox owner's: B's stuck letter is in B's Sent, not A's.
    `SELECT id, subject, letter_text, sent_from FROM applications
     WHERE status = 'sending'
       AND profile_id = $3
       AND lower(sent_to) = lower($1)
       AND sending_since > now() - interval '7 days'
       AND sending_since < $2::timestamptz + interval '1 minute'
     ORDER BY sending_since DESC LIMIT 1`,
    [toAddr, när, profileId]
  );
  if (!ap) return null;

  const klient = await pool.connect();
  try {
    await klient.query('BEGIN');
    // Still conditional: two passes over Sent must not both repair it.
    const { rowCount } = await klient.query(
      `UPDATE applications SET status = 'sent', message_id = $2, sent_at = $3,
         sending_since = NULL, updated_at = now()
       WHERE id = $1 AND status = 'sending'`,
      [ap.id, parsed.messageId || null, när]
    );
    if (!rowCount) { await klient.query('ROLLBACK'); return null; }
    await klient.query(
      `INSERT INTO email_messages (application_id, direction, message_id, from_addr,
         to_addr, subject, body_text, imap_uid, sent_at)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8)`,
      [ap.id, parsed.messageId || null, ap.sent_from, toAddr,
       parsed.subject || ap.subject, (parsed.text || '').trim() || ap.letter_text, uid, när]
    );
    await klient.query('COMMIT');
  } catch (err) {
    await klient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    klient.release();
  }
  console.log(`  ✓ lagade utskick som fastnat: ${toAddr} (${ap.id})`);
  return ap.id;
}

async function findSentMailbox(imap) {
  const boxes = await imap.list();
  const hit = boxes.find((b) => b.specialUse === '\\Sent')
    || boxes.find((b) => /^\[Gmail\]\/(Sent Mail|Skickat)$/i.test(b.path));
  return hit?.path || null;
}

// What the owner's Sent folder is worth searching for: their open threads
// with an employer's answer and none of theirs yet, and their letters
// stuck in 'sending'. Never another user's.
export async function attLetaIskickat(profileId) {
  kräverÄgare(profileId, 'attLetaIskickat');
  // The threads this app is actually in. Sent holds years of the
  // user's own correspondence, and none of it is the app's business —
  // so the server is asked for the specific messages that answer a
  // letter we sent, rather than being read through.
  //
  // One IMAP SEARCH per thread, keyed on the RECIPIENT and bounded by
  // the date we wrote to them.
  //
  // The obvious key is the message id we stored — the reply carries it
  // in References, verified on a real thread. But Gmail's IMAP does not
  // answer HEADER searches for References: the search returns nothing
  // while the header plainly contains the id. Searching `to:` returns
  // the thread (our letter plus the answer), and the id check then
  // happens here, on the two messages that came back.
  // Only threads the user could have answered: an employer wrote, and
  // no reply of ours is stored yet. Every application would be 146
  // searches and three minutes, which is no good on a poll — this is
  // usually a handful, and the ones that matter.
  const { rows: trådar } = await pool.query(
    `SELECT a.id, a.message_id, a.sent_to, a.sent_at
     FROM applications a
     WHERE a.profile_id = $1
       AND a.message_id IS NOT NULL AND a.sent_to IS NOT NULL
       AND a.status IN ${OPEN_STATUSES}
       AND a.sent_at > now() - interval '90 days'
       AND EXISTS (SELECT 1 FROM email_messages m
                   WHERE m.application_id = a.id AND m.direction = 'inbound')
       -- our own first letter is outbound too, so "already answered"
       -- means an outbound message that is not that letter
       AND NOT EXISTS (SELECT 1 FROM email_messages m
                       WHERE m.application_id = a.id AND m.direction = 'outbound'
                         AND m.message_id IS DISTINCT FROM a.message_id)
     ORDER BY a.sent_at DESC
     LIMIT 50`,
    [profileId]
  );
  // Plus the letters this app handed to Gmail and never finished
  // recording. They have a recipient and a claim time and nothing else,
  // so they are looked for the same way — by address, from the claim
  // onwards — and repaired in handleSent.
  const { rows: fastnade } = await pool.query(
    `SELECT id, sent_to, sending_since AS sent_at
     FROM applications
     WHERE profile_id = $1
       AND status = 'sending' AND sent_to IS NOT NULL
       AND sending_since > now() - interval '7 days'
     ORDER BY sending_since DESC
     LIMIT 20`,
    [profileId]
  );
  return { trådar, fastnade };
}

export async function catchUpSent(imap, profileId) {
  const { trådar, fastnade } = await attLetaIskickat(profileId);
  if (!trådar.length && !fastnade.length) return;

  const path = await findSentMailbox(imap);
  if (!path) return;

  // One pass over Sent, not one search per thread.
  //
  // Twenty-four threads meant twenty-four SEARCHes and twenty-four
  // source fetches: three minutes and sixteen seconds, on a poll that
  // fires every five — so it was still working when the next one
  // started, holding the mailbox lock and keeping INBOX from being
  // read. A reply written in Gmail could sit unseen for hours.
  //
  // Instead: one date-bounded fetch of ENVELOPES, which carry To,
  // Message-ID and In-Reply-To without downloading a single body. The
  // matching happens here, and only the handful that match a known
  // thread are fetched in full.
  const tillAdress = new Map();
  const våraId = new Set();
  let äldst = Date.now();
  for (const t of [...trådar, ...fastnade]) {
    tillAdress.set(String(t.sent_to).toLowerCase(), t);
    // A stuck row has no id to exclude by — its letter is precisely
    // what we are looking for here.
    if (t.message_id) våraId.add(t.message_id);
    äldst = Math.min(äldst, new Date(t.sent_at).getTime());
  }

  // A lock rather than a bare open: this runs while the connection is
  // sitting in IDLE on INBOX, and imapflow needs to serialise the
  // mailbox switch and put IDLE back afterwards. Opening directly here
  // races with the idling read.
  const lock = await imap.getMailboxLock(path, { readOnly: true });
  try {
    let kandidater = [];
    try {
      kandidater = await imap.search({ since: new Date(äldst) }, { uid: true }) || [];
    } catch (err) {
      console.error(`sent-search: ${err.message}`);
      return;
    }
    if (!kandidater.length) return;

    const värda = [];
    for await (const msg of imap.fetch(kandidater, { uid: true, envelope: true }, { uid: true })) {
      const env = msg.envelope || {};
      const till = (env.to || []).map((a) => String(a.address || '').toLowerCase());
      const tråd = till.map((a) => tillAdress.get(a)).find(Boolean);
      if (!tråd) continue;
      // Our own letter to that employer is already stored; everything
      // else addressed to them is the user's own writing.
      if (env.messageId && våraId.has(env.messageId)) continue;
      värda.push(msg.uid);
    }
    if (!värda.length) return;

    for await (const msg of imap.fetch(värda, { uid: true, source: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source);
      await handleSent(parsed, msg.uid, profileId).catch((e) => console.error('sent:', e.message));
    }
  } finally {
    lock.release();
  }
}

// medSkickat=false skips the Sent pass, which is one IMAP SEARCH per
// unanswered thread and takes 35 seconds where INBOX takes two. Nobody
// waits 35 seconds for a button, and the thing they pressed it for is
// new mail — what they sent themselves, they already know about.
//
// iTur serialises the INBOX part per mailbox: IDLE, the poll and the
// button can all ask at once, and two passes over the same UIDs would
// race each other past the message-id check and classify a reply twice.
async function catchUp(imap, ägare, { medSkickat = true, iTur = (fn) => fn() } = {}) {
  // Sent first, so a thread the user already answered is up to date
  // before anything decides it needs a draft.
  if (medSkickat) {
    await catchUpSent(imap, ägare.profileId).catch((e) => console.error('sent-catchup:', e.message));
  }
  await iTur(() => läsInkorgen(imap, ägare));
}

// A mailbox lock, not mailboxOpen. The Sent pass holds a lock on Sent,
// and a bare open issued while it runs switches the selected mailbox
// out from under its fetch — both then wait forever. That is exactly
// what a "Hämta post" pressed during a mailbox's first catch-up did.
// The lock makes imapflow queue the switch behind the Sent pass, and
// leaves INBOX selected afterwards, which is where IDLE should sit.
async function läsInkorgen(imap, ägare) {
  const state = await läsposition(ägare.profileId, MAILBOX);
  const lock = await imap.getMailboxLock(MAILBOX);
  try {
    await läsInkorgenLåst(imap, ägare, state, imap.mailbox);
  } finally {
    lock.release();
  }
}

async function läsInkorgenLåst(imap, ägare, state, box) {
  const sammaNumrering = state && Number(state.uid_validity) === Number(box.uidValidity);

  let urval;
  let sinceUid = 0;
  let från = null;
  if (sammaNumrering) {
    sinceUid = Number(state.last_seen_uid);
    urval = `${sinceUid + 1}:*`;
  } else {
    // No position yet, or Gmail renumbered the mailbox. Either way the
    // read starts at the user's first letter sent from here — the rest
    // of the inbox is their own life and is never fetched.
    const första = await förstaBrevet(ägare.profileId);
    if (!första) return;
    // A few minutes of slack for clocks that disagree; SINCE itself is
    // a whole day, and internalDate narrows it to the minute below.
    från = new Date(new Date(första).getTime() - 5 * 60 * 1000);
    urval = await imap.search({ since: från }, { uid: true }) || [];
  }

  // Everything below uidNext that the search did not return is older
  // than the first letter, so the position moves past it as well.
  let maxUid = sammaNumrering ? sinceUid : Math.max(0, Number(box.uidNext || 1) - 1);
  if (urval.length) {
    const fält = { uid: true, source: true, internalDate: true };
    for await (const msg of imap.fetch(urval, fält, { uid: true })) {
      if (msg.uid <= sinceUid) continue;
      maxUid = Math.max(maxUid, msg.uid);
      if (från && msg.internalDate && new Date(msg.internalDate) < från) continue;
      const parsed = await simpleParser(msg.source);
      await handleMessage(parsed, msg.uid, ägare).catch((e) => console.error('handle:', e.message));
    }
  }

  await sparaLäsposition(ägare.profileId, MAILBOX, box.uidValidity, maxUid);
}

// The owner's stored messages — what "Hämta post" reports as new. Every
// user's mail used to be counted, so one user's button reported another
// user's replies arriving.
export async function antalMeddelanden(profileId) {
  kräverÄgare(profileId, 'antalMeddelanden');
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM email_messages m
     JOIN applications a ON a.id = m.application_id
     WHERE a.profile_id = $1`, [profileId]);
  return r.n;
}

// ------------------------------------------------------------
// One catch-up, on demand, from the UI — when the worker has no open
// mailbox for this user to answer it with.
//
// The worker's mailbox is the normal path and this is not a
// replacement for it — it exists because the loop went silent for seven
// hours once, and the only way to find out was to ask someone to look.
// A button that fetches is a thing the user can press instead of
// wondering.
//
// Opens its own short-lived connection to the presser's own mailbox.
// Idempotent: every insert is guarded on message_id, so pressing it
// twice stores nothing twice.
//
// INBOX only. The Sent pass costs 35 seconds against two for this, and
// the user pressing "hämta post" is asking about replies, not about
// mail they wrote themselves — syncSentNow does that afterwards.
// ------------------------------------------------------------
export async function syncNow(profileId) {
  const ägare = await ägareFör(profileId);
  const före = await antalMeddelanden(profileId);
  // Nothing sent through the app means nothing of the app's to read.
  if (!(await förstaBrevet(profileId))) return { nya: 0, totalt: före };
  const imap = imapKlient(ägare);
  try {
    await imap.connect();
    await catchUp(imap, ägare, { medSkickat: false });
  } finally {
    await imap.logout().catch(() => { /* closing is best-effort */ });
  }
  const efter = await antalMeddelanden(profileId);
  return { nya: efter - före, totalt: efter };
}

// The Sent pass, on its own connection.
//
// INBOX answers in two seconds and this takes thirty, and the button
// was pressed to see whether anything came IN. So the caller starts
// this and does not wait for it: the count comes back at once, and a
// reply the user wrote in Gmail lands a few seconds later — which the
// inbox's own three-second poll then shows without anyone doing
// anything.
export async function syncSentNow(profileId) {
  if (!(await attLetaIskickat(profileId).then((l) => l.trådar.length + l.fastnade.length))) return;
  const imap = imapKlient(await ägareFör(profileId));
  try {
    await imap.connect();
    await catchUpSent(imap, profileId);
  } finally {
    await imap.logout().catch(() => { /* closing is best-effort */ });
  }
}

// ------------------------------------------------------------
// A password Gmail no longer accepts.
//
// The app password was revoked, or the user changed their Google
// password, which revokes them all. Retrying that forever is how an
// account gets locked for suspicious sign-ins — so after a few refusals
// in a row the mailbox stops, the profile stops counting as connected,
// and the settings page says why. Saving a new password clears it, and
// the manager starts the mailbox again within a minute.
//
// Only a refusal counts. A network error, a timeout or Gmail being
// briefly unwell says nothing about the password and is retried for as
// long as it takes.
// ------------------------------------------------------------
export function ärLösenordsfel(err) {
  if (err?.authenticationFailed) return true;
  const text = `${err?.serverResponseCode || ''} ${err?.response || ''} ${err?.message || ''}`;
  return /AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted|Application-specific password required/i
    .test(text);
}

const LÖSENORDET_NEKAS = 'Gmail godtar inte längre applösenordet. Skapa ett nytt och lägg in det här.';
// The stored value could not be decrypted — the platform's key changed.
const LÖSENORDET_OLÄSBART = 'Det sparade applösenordet kunde inte läsas. Lägg in det igen.';

async function markeraLösenordsfel(profileId, text) {
  await pool.query(
    `UPDATE profile SET gmail_verified_at = NULL, gmail_error = $2, gmail_error_at = now(),
       updated_at = now()
     WHERE id = $1`,
    [profileId, text]);
}

// ------------------------------------------------------------
// One user's mailbox: connect → catch up → IDLE, and back again with
// exponential backoff whenever the connection dies.
//
// An instance per user, and everything it knows lives inside it — the
// connection, the owner, the backoff, the failure count — or in that
// user's rows (imap_state). Nothing here is shared with any other
// user's mailbox, so one user's broken connection or wrong password
// touches nobody else. The worker's manager (src/imapManager.js) makes
// these, one per user, and stops them again.
//
// kör() runs until the mailbox is stopped ('stoppad'), Gmail keeps
// refusing the password ('lösenord'), or the user has no password at
// all ('saknas'). klient and paus are there so the proof can run it
// against a fake server without waiting out real backoff.
// ------------------------------------------------------------
export function brevlåda(profileId, { klient = imapKlient, paus = null, lösenordsgräns = 3 } = {}) {
  kräverÄgare(profileId, 'brevlåda');
  const avbryt = new AbortController();
  const vänta = paus || ((ms) => new Promise((klar) => {
    const t = setTimeout(klar, ms);
    avbryt.signal.addEventListener('abort', () => { clearTimeout(t); klar(); }, { once: true });
  }));

  let imap = null;
  let ägare = null;
  let backoff = 2000;
  let lösenordsfel = 0;
  // A failure that repeats every minute is said once, and again only
  // when the reason changes.
  let senasteFel = null;

  let kö = Promise.resolve();
  const iTur = (fn) => {
    const p = kö.then(fn);
    kö = p.catch(() => {});
    return p;
  };

  // The Sent pass leaves Sent selected, and IDLE would then watch Sent
  // instead of INBOX until something reopened it. So every Sent pass on
  // the long-lived connection ends with INBOX selected again — which
  // also reads anything that arrived meanwhile.
  async function skickatSedanInkorgen(c) {
    try {
      await catchUpSent(c, profileId);
    } finally {
      await iTur(() => läsInkorgen(c, ägare));
    }
  }

  async function enAnslutning() {
    // Read again on every connect: a password saved since the last one
    // takes effect without restarting anything.
    ägare = await ägareFör(profileId);
    const c = klient(ägare);
    imap = c;
    // Listened for before connecting, so a connection that dies during
    // the first catch-up is not waited on forever.
    const stängd = new Promise((resolve, reject) => {
      c.on('close', resolve);
      c.on('error', reject);
    });
    stängd.catch(() => {});
    const timrar = [];
    try {
      await c.connect();
      if (avbryt.signal.aborted) return;
      console.log(`imap: ansluten (${ägare.user})`);
      backoff = 2000;
      lösenordsfel = 0;
      senasteFel = null;

      await catchUp(c, ägare, { iTur });

      c.on('exists', () => {
        catchUp(c, ägare, { iTur }).catch((e) => console.error('imap catchup:', e.message));
      });

      // IDLE fires for INBOX, so a reply the user sends from Gmail is
      // not an event this connection ever hears about. Polled instead,
      // and slowly: the user knows what they just sent — this is about
      // the app agreeing with them within a few minutes.
      timrar.push(setInterval(() => {
        skickatSedanInkorgen(c).catch((e) => console.error('sent-poll:', e.message));
      }, 5 * 60 * 1000));

      // ------------------------------------------------------------
      // Do not trust IDLE to be the only way mail arrives.
      //
      // This connection went seven hours without ingesting anything
      // while the worker was plainly alive and doing other work: the
      // last stored reply was 02:05, and twenty employer answers sat in
      // Gmail above the cursor, matched and unread. No error, no close
      // event — the exact failure CLAUDE.md warns is worse than any
      // latency problem, and a silent one.
      //
      // A catch-up on a timer costs one FETCH from the cursor, which is
      // nothing when there is no new mail, and makes the worst case a
      // two-minute delay instead of indefinite silence. The noop is the
      // other half: a socket that has quietly died answers it with an
      // error, which tears the connection down and lets the loop
      // reconnect rather than waiting on a 'close' that never comes.
      timrar.push(setInterval(async () => {
        try {
          await c.noop();
          await catchUp(c, ägare, { iTur });
        } catch (e) {
          console.error('imap-poll:', e.message);
          c.close();
        }
      }, 2 * 60 * 1000));

      // imapflow keeps IDLE alive internally; block until the connection dies
      await stängd;
      console.log(`imap: anslutningen stängd (${ägare.user})`);
    } finally {
      for (const t of timrar) clearInterval(t);
      await c.logout().catch(() => { /* already gone */ });
      if (imap === c) imap = null;
    }
  }

  async function kör() {
    while (!avbryt.signal.aborted) {
      try {
        await enAnslutning();
      } catch (err) {
        if (avbryt.signal.aborted) break;
        if (err instanceof GmailSaknasError) {
          // Otherwise the manager would start it again every minute.
          await markeraLösenordsfel(profileId, LÖSENORDET_OLÄSBART);
          console.log(`imap: ${profileId} har inget läsbart applösenord — brevlådan stängs`);
          return 'saknas';
        }
        lösenordsfel = ärLösenordsfel(err) ? lösenordsfel + 1 : 0;
        if (lösenordsfel >= lösenordsgräns) {
          await markeraLösenordsfel(profileId, LÖSENORDET_NEKAS);
          console.error(`imap: Gmail vägrar lösenordet för ${ägare?.user || profileId} `
            + `${lösenordsfel} gånger i rad — brevlådan stängs tills ett nytt sparas`);
          return 'lösenord';
        }
        if (err.message !== senasteFel) console.error(`imap (${ägare?.user || profileId}):`, err.message);
        senasteFel = err.message;
      }
      if (avbryt.signal.aborted) break;
      await vänta(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
    return 'stoppad';
  }

  // "Hämta post", on the connection that is already open — about two
  // seconds, where a fresh connection costs seventeen before a single
  // message is read (10.5 to connect, 6.7 to open a 28,377-message
  // INBOX). INBOX first, and the caller is answered the moment it is
  // done; the Sent pass follows on its own.
  async function synka() {
    const c = imap;
    if (!c?.usable) throw new Error('brevlådan är inte ansluten just nu');
    await catchUp(c, ägare, { medSkickat: false, iTur });
    skickatSedanInkorgen(c).catch((e) => console.error('sent-sync:', e.message));
  }

  function stoppa() {
    avbryt.abort();
    imap?.logout().catch(() => { /* closing is best-effort */ });
  }

  return { profileId, kör, synka, stoppa, ansluten: () => Boolean(imap?.usable) };
}
