// Clears addresses that cannot be mailed.
//
// Scraped addresses reach ads.apply_email with nobody reading them, so
// a parse artefact — "hareton@cleverex.se\", a mailto capture that ran
// past an escaped quote — becomes a letter Gmail rejects with
// 555-5.5.2. Removing it puts the ad back among the ones the scanner
// will look at again.
import 'dotenv/config';
import { pool } from '../src/db.js';

const OK = /^[^@\s<>\\"',;]+@[^@\s<>\\"',;]+\.[a-z]{2,}$/i;

const { rows } = await pool.query(
  `SELECT id, apply_email, employer FROM ads WHERE apply_email IS NOT NULL`
);
const bad = rows.filter((r) => !OK.test(r.apply_email));

console.log(`${rows.length} adresser, ${bad.length} går inte att skicka till`);
for (const r of bad) console.log(`  ${JSON.stringify(r.apply_email)}  ${r.employer}`);

if (bad.length) {
  await pool.query(
    `UPDATE ads SET apply_email = NULL, apply_email_source = NULL WHERE id = ANY($1)`,
    [bad.map((r) => r.id)]
  );
  console.log('rensade — annonserna kan hittas igen av skanningen');
}

await pool.end();
