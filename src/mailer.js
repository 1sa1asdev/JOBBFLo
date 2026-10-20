import { pool } from './db.js';
import { adressFör } from './addresses.js';
import { gmailFör, smtpTransport } from './credentials.js';

// ------------------------------------------------------------
// Outgoing mail. The ONLY function that sends anything, and it
// is only ever called from the user-initiated send endpoint —
// there is no scheduled or automatic path into this file.
//
// Every send goes out through the account of the application's owner
// (src/credentials.js), never through a server-wide one.
// ------------------------------------------------------------

// plus-alias: din+frontend@gmail.com — Gmail delivers it to the same
// inbox but lets replies be traced back to the search that sent them.
function aliasFrom(alias, user) {
  if (!alias) return user;
  return alias.includes('@') ? alias : user.replace('@', `+${alias}@`);
}

// ------------------------------------------------------------
// Files that go WITH the letter. Ads ask for "CV och personligt
// brev", so a letter on its own is an incomplete application.
// The CV follows the same precedence as its text: a search's own
// tailored CV wins over the profile's base one.
// ------------------------------------------------------------
export async function attachmentsFor(applicationId) {
  // Precedence, narrowest first: this application's own CV, then the
  // search's tailored one, then the profile's base. COALESCE per column
  // would be wrong — it could pair one CV's bytes with another's
  // filename — so the whole document is chosen as a unit.
  const { rows: [row] } = await pool.query(
    `SELECT
       COALESCE(a.cv_file, s.cv_file, p.cv_file) AS cv_file,
       CASE
         WHEN a.cv_file IS NOT NULL THEN a.cv_filename
         WHEN s.cv_file IS NOT NULL THEN s.cv_filename
         ELSE p.cv_filename
       END AS cv_filename,
       CASE
         WHEN a.cv_file IS NOT NULL THEN a.cv_mime
         WHEN s.cv_file IS NOT NULL THEN s.cv_mime
         ELSE p.cv_mime
       END AS cv_mime,
       p.id AS profile_id, a.origin_search_id
     FROM applications a
     JOIN profile p  ON p.id = a.profile_id
     LEFT JOIN searches s ON s.id = a.origin_search_id
     WHERE a.id = $1`,
    [applicationId]
  );
  if (!row) return [];

  const files = [];
  if (row.cv_file) {
    files.push({
      filename: row.cv_filename || 'cv.pdf',
      content: row.cv_file,
      contentType: row.cv_mime || undefined,
    });
  }

  // profile-wide extras (search_id NULL) plus anything attached to
  // the campaign this application came from
  const { rows: extra } = await pool.query(
    `SELECT a.filename, a.mime, a.bytes FROM attachments a
     WHERE a.profile_id = $1
       AND a.include_by_default
       AND (a.search_id IS NULL OR a.search_id = $2)
     ORDER BY a.created_at`,
    [row.profile_id, row.origin_search_id || null]
  );
  for (const f of extra) {
    files.push({ filename: f.filename, content: f.bytes, contentType: f.mime || undefined });
  }
  return files;
}

// ------------------------------------------------------------
// sendApplication: send the approved letter for an application.
// Stores messageId on the row — reply matching depends on it.
// ------------------------------------------------------------
export async function sendApplication(applicationId, { to } = {}) {
  const { rows: [app] } = await pool.query(
    `SELECT a.*, ads.title, ads.employer, ${adressFör('ads', 'a.profile_id')} AS apply_email, s.email_alias
     FROM applications a
     JOIN ads ON ads.id = a.ad_id
     LEFT JOIN searches s ON s.id = a.origin_search_id
     WHERE a.id = $1`, [applicationId]
  );
  if (!app) throw new Error(`no application ${applicationId}`);
  if (app.status !== 'drafted') throw new Error('already sent');

  const recipient = to || app.apply_email;
  if (!recipient) throw new Error('annonsen saknar ansöknings-mejl — sök via länken istället');

  // Deliberately NO address-duplicate check here. This function serves
  // both paths, and applying by hand to two roles at one employer is a
  // decision the user is entitled to make — a human is reading each
  // letter before it goes. The address guard belongs to campaigns,
  // where nobody is, and lives in candidatesFor and the auto-only
  // unique index instead.
  // The owner's account, fetched before anything is claimed: a user who
  // has not connected Gmail gets told so, and no row starts 'sending'.
  const gmail = await gmailFör(app.profile_id);
  const from = aliasFrom(app.email_alias, gmail.user);
  // The sender's name is the application's owner, not the first profile.
  const { rows: [profile] } = await pool.query(
    `SELECT name FROM profile WHERE id = $1`, [app.profile_id]);

  const attachments = await attachmentsFor(applicationId);

  // The row claims itself before the letter leaves. Conditional on
  // still being a draft, so two runs cannot both get past this line —
  // and after it, a row that never reaches 'sent' is a letter whose
  // outcome is unknown rather than one that looks unsent and invites a
  // second copy.
  //
  // The recipient is written down as part of the claim, not with the
  // result. It is the only thing that can find the letter again: the
  // Sent-folder sync looks a stuck row up by address and date
  // (repareraSending in src/imap.js), and a row that knows only that
  // it was sending something, somewhere, is unrepairable.
  const { rowCount: claimed } = await pool.query(
    `UPDATE applications SET status = 'sending', sending_since = now(),
       sent_to = $2, sent_from = $3, updated_at = now()
     WHERE id = $1 AND status = 'drafted'`, [applicationId, recipient, from]);
  if (!claimed) throw new Error('already sent');

  let info;
  try {
    info = await smtpTransport(gmail).sendMail({
      from: `"${profile?.name || ''}" <${from}>`,
      to: recipient,
      subject: app.subject,
      text: app.letter_text,
      attachments,
    });
  } catch (err) {
    // Nothing left: SMTP refused it, so the draft goes back to being a
    // draft and the caller decides (the campaign pauses, a person
    // retries). Only a send that was ACCEPTED must not be reopened.
    await pool.query(
      `UPDATE applications SET status = 'drafted', sending_since = NULL,
         sent_to = NULL, sent_from = NULL, updated_at = now()
       WHERE id = $1 AND status = 'sending'`, [applicationId]).catch(() => {});
    throw err;
  }

  // Both writes together. Separately, a failure between them left an
  // application marked sent with no record of the message — and reply
  // matching reads that record.
  const klient = await pool.connect();
  try {
    await klient.query('BEGIN');
    await klient.query(
      `UPDATE applications SET
         status = 'sent', message_id = $2, sent_to = $3, sent_from = $4,
         sent_at = now(), sending_since = NULL, updated_at = now()
       WHERE id = $1`,
      [applicationId, info.messageId, recipient, from]
    );
    await klient.query(
      `INSERT INTO email_messages (application_id, direction, message_id, from_addr, to_addr, subject, body_text, sent_at)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6, now())`,
      [applicationId, info.messageId, from, recipient, app.subject, app.letter_text]
    );
    await klient.query('COMMIT');
  } catch (err) {
    await klient.query('ROLLBACK').catch(() => {});
    // The letter IS sent. Say so loudly and leave the row in 'sending':
    // the Sent-folder sync finds it by recipient and repairs it, and a
    // row in 'sending' is never offered a Skicka button.
    console.error(`SKICKAT MEN EJ SPARAT: ${recipient} (${applicationId}) — ${err.message}`);
    throw err;
  } finally {
    klient.release();
  }

  return {
    messageId: info.messageId, to: recipient, from,
    attachments: attachments.map((a) => a.filename),
  };
}

// ------------------------------------------------------------
// sendReply: user-approved reply in an existing thread.
// Threads correctly via In-Reply-To/References.
// ------------------------------------------------------------
export async function sendReply(applicationId, body, { suggestedReplyId = null } = {}) {
  const { rows: [app] } = await pool.query(
    `SELECT * FROM applications WHERE id = $1`, [applicationId]
  );
  if (!app) throw new Error(`no application ${applicationId}`);

  const { rows: [lastIn] } = await pool.query(
    `SELECT * FROM email_messages
     WHERE application_id = $1 AND direction = 'inbound'
     ORDER BY sent_at DESC LIMIT 1`, [applicationId]
  );

  const to = lastIn?.from_addr || app.sent_to;
  if (!to) throw new Error('ingen mottagare i tråden');

  const gmail = await gmailFör(app.profile_id);
  const from = app.sent_from || gmail.user;
  const refs = [
    ...(lastIn?.references_ids || []),
    ...(lastIn?.message_id ? [lastIn.message_id] : []),
  ];
  const { rows: [profile] } = await pool.query(
    `SELECT name FROM profile WHERE id = $1`, [app.profile_id]);

  const info = await smtpTransport(gmail).sendMail({
    from: `"${profile?.name || ''}" <${from}>`,
    to,
    subject: lastIn?.subject?.startsWith('Re:') ? lastIn.subject : `Re: ${lastIn?.subject || app.subject}`,
    text: body,
    inReplyTo: lastIn?.message_id,
    references: refs,
  });

  await pool.query(
    `INSERT INTO email_messages (application_id, direction, message_id, in_reply_to, references_ids,
       from_addr, to_addr, subject, body_text, sent_at)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, now())`,
    [applicationId, info.messageId, lastIn?.message_id || null, refs, from, to,
     lastIn?.subject || app.subject, body]
  );

  if (suggestedReplyId) {
    await pool.query(`UPDATE suggested_replies SET dismissed = true WHERE id = $1`, [suggestedReplyId]);
  }

  return { messageId: info.messageId, to };
}
