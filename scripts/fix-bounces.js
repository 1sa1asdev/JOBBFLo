// Corrects applications whose status came from a bounce notice.
//
// Before bounces were told apart from replies, a "Delivery Status
// Notification (Failure)" was matched to its application, classified
// as the employer's answer and recorded as a rejection: 19 of 124.
// This walks the stored mail, re-decides each one with the same rule
// the inbox now uses, and fixes what it finds.
//
// Run with --dry to see the plan without changing anything.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { ärStuds } from '../src/imap.js';

const dry = process.argv.includes('--dry');

const { rows } = await pool.query(
  `SELECT em.id, em.application_id, em.from_addr, em.subject, em.body_text,
          ap.status, ap.sent_to, ap.ad_id, a.apply_email
   FROM email_messages em
   JOIN applications ap ON ap.id = em.application_id
   LEFT JOIN ads a ON a.id = ap.ad_id
   WHERE em.direction = 'inbound'
   ORDER BY em.created_at`);

let permanenta = 0;
let tillfälliga = 0;
let rättade = 0;
let adresser = 0;

for (const m of rows) {
  const studs = ärStuds(m.from_addr, m.subject, m.body_text);
  if (!studs) continue;
  if (!studs.permanent) { tillfälliga += 1; continue; }
  permanenta += 1;

  const behöverStatus = m.status !== 'undeliverable';
  const behöverAdress = m.apply_email && m.sent_to
    && m.apply_email.toLowerCase() === m.sent_to.toLowerCase();
  if (!behöverStatus && !behöverAdress) continue;

  console.log(`${m.status.padEnd(12)} → undeliverable  ${(m.sent_to || '—').padEnd(38)}`
    + `${behöverAdress ? ' (adressen tas bort)' : ''}`);
  if (dry) continue;

  if (behöverStatus) {
    const { rowCount } = await pool.query(
      `UPDATE applications SET status = 'undeliverable', bounced_at = now(), updated_at = now()
       WHERE id = $1`, [m.application_id]);
    rättade += rowCount;
  }
  if (behöverAdress) {
    const { rowCount } = await pool.query(
      `UPDATE ads SET apply_email = NULL, apply_email_source = NULL, apply_email_found_at = NULL
       WHERE id = $1 AND lower(apply_email) = lower($2)`, [m.ad_id, m.sent_to]);
    adresser += rowCount;
  }
}

console.log(`\n${permanenta} permanenta studsar, ${tillfälliga} fördröjningar (rörs inte)`);
console.log(dry
  ? 'torrkörning — inget ändrat'
  : `${rättade} ansökningar rättade, ${adresser} adresser borttagna från annonser`);

const { rows: [efter] } = await pool.query(
  `SELECT count(*) FILTER (WHERE status = 'rejected')::int AS avslag,
          count(*) FILTER (WHERE status = 'undeliverable')::int AS kom_inte_fram
   FROM applications`);
console.log(`avslag nu: ${efter.avslag}, kom inte fram: ${efter.kom_inte_fram}`);
await pool.end();
