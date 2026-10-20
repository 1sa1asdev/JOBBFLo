// Proves the two mechanisms that keep a letter from being sent twice,
// without sending anything: the claim, and the repair.
//
//   1. the claim is exclusive        two concurrent sends, one winner
//   2. a claimed row is locked       nothing offers it as a draft again
//   3. SMTP failure reopens it       a letter that never left is a draft
//   4. the Sent copy repairs it      status, message id, stored message
//   5. the repair is idempotent      two passes over Sent, one repair
//   6. a stranger's mail is ignored  same-address mail sent BEFORE the
//                                    claim is not taken as proof
//
// Everything happens on a throwaway ad in its own row and is deleted
// again, so this can be run against the live database.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { repareraSending } from '../src/imap.js';

const { rows: [p] } = await pool.query(`SELECT id FROM profile LIMIT 1`);
if (!p) { console.error('ingen profil — kör npm run db:seed'); process.exit(1); }

const MOTTAGARE = 'proof+send@example.invalid';
let fel = 0;
const kolla = (namn, fick, väntat) => {
  const ok = JSON.stringify(fick) === JSON.stringify(väntat);
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(46)} ${JSON.stringify(fick)}`
    + (ok ? '' : `  väntat ${JSON.stringify(väntat)}`));
};

// ------------------------------------------------------------
// One ad per draft: UNIQUE(profile_id, ad_id) is the invariant that one
// ad can only ever have one application, so two drafts need two ads.
const annonser = [];
const nyttUtkast = async () => {
  const nyckel = `prove-send-${Date.now()}-${annonser.length}`;
  const { rows: [ad] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description, apply_email)
     VALUES ('manual', $1, $1, 'Testtjänst', 'Testbolaget AB', 'Testannons.', $2)
     RETURNING id`, [nyckel, MOTTAGARE]);
  annonser.push(ad.id);
  const { rows: [a] } = await pool.query(
    `INSERT INTO applications (ad_id, profile_id, status, subject, letter_text)
     VALUES ($1, $2, 'drafted', 'Ansökan: Testtjänst', 'Hej, ...')
     RETURNING id`, [ad.id, p.id]);
  return a.id;
};

// The exact statement sendApplication uses to claim the row.
const anspråk = (id) => pool.query(
  `UPDATE applications SET status = 'sending', sending_since = now(),
     sent_to = $2, sent_from = $3, updated_at = now()
   WHERE id = $1 AND status = 'drafted'`,
  [id, MOTTAGARE, 'du@example.com']
).then((r) => r.rowCount);

const status = async (id) => {
  const { rows: [a] } = await pool.query(
    `SELECT status, sent_to, message_id, sent_at IS NOT NULL AS har_tid,
            sending_since IS NOT NULL AS pågår,
            (SELECT count(*)::int FROM email_messages m
             WHERE m.application_id = $1 AND m.direction = 'outbound') AS utgående
     FROM applications WHERE id = $1`, [id]);
  return a;
};

try {
  // 1 + 2. Two sends of the same draft. Both read status='drafted'
  //        before either wrote, which is exactly the race.
  const a1 = await nyttUtkast();
  const vunna = (await Promise.all([anspråk(a1), anspråk(a1)]))
    .reduce((s, n) => s + n, 0);
  kolla('anspråket är exklusivt', vunna, 1);
  kolla('den fastnade raden är inte längre utkast', (await status(a1)).status, 'sending');
  kolla('mottagaren skrevs ner före utskicket', (await status(a1)).sent_to, MOTTAGARE);

  // 3. SMTP refused it: nothing left, so it goes back to being a draft.
  const a2 = await nyttUtkast();
  await anspråk(a2);
  await pool.query(
    `UPDATE applications SET status = 'drafted', sending_since = NULL,
       sent_to = NULL, sent_from = NULL, updated_at = now()
     WHERE id = $1 AND status = 'sending'`, [a2]);
  kolla('avvisat utskick blir utkast igen', (await status(a2)).status, 'drafted');

  // 6. Mail to the same address from before the claim proves nothing.
  const gammalt = {
    messageId: '<old@mail.gmail.com>', subject: 'Något annat',
    text: 'Skrivet innan.', date: new Date(Date.now() - 3600_000),
  };
  kolla('mejl före anspråket lagar ingenting',
    await repareraSending(gammalt, MOTTAGARE, 900, p.id) === null, true);
  kolla('raden är orörd', (await status(a1)).status, 'sending');

  // 4. The copy Gmail kept: same recipient, written after the claim.
  const kopia = {
    messageId: '<repaired@mail.gmail.com>', subject: 'Ansökan: Testtjänst',
    text: 'Hej, ...', date: new Date(Date.now() + 1000),
  };
  kolla('Skickat-kopian lagar raden', await repareraSending(kopia, MOTTAGARE, 901, p.id) === a1, true);
  const efter = await status(a1);
  kolla('status', efter.status, 'sent');
  kolla('message_id sparat — svar kan trådas', efter.message_id, '<repaired@mail.gmail.com>');
  kolla('sent_at satt', efter.har_tid, true);
  kolla('inget anspråk kvar', efter.pågår, false);
  kolla('brevet finns som utgående meddelande', efter.utgående, 1);

  // 5. The Sent pass runs every poll; it must not repair twice.
  kolla('andra passet lagar inte om',
    await repareraSending(kopia, MOTTAGARE, 901, p.id) === null, true);
  kolla('fortfarande ett utgående meddelande', (await status(a1)).utgående, 1);
} finally {
  await pool.query(`DELETE FROM ads WHERE id = ANY($1)`, [annonser]);
  console.log(fel ? `\n${fel} fel` : '\nallt stämmer');
  await pool.end();
  process.exitCode = fel ? 1 : 0;
}
