// Proves the one-letter-per-company-per-month rule against real data,
// without sending anything and without writing a row.
//
// Each case picks an actual ad and asks the exact SQL the campaign uses
// (nyligenKontaktat) whether it would be blocked:
//
//   same organisation number, different address   → blocked
//   a company last written to more than 30 days ago → allowed
//   a company never written to                     → allowed
//   an unrelated employer on gmail.com             → not grouped
//
// The cases are picked from ads that sit in a search, not from all 43k:
// the campaign only ever asks about its own candidates, and scanning
// the whole pool with case-insensitive comparisons took minutes for a
// question the real code answers in 63ms.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { nyligenKontaktat, FÖRETAGSPAUS_DAGAR } from '../src/autoapply.js';

const { rows: [p] } = await pool.query(`SELECT id FROM profile LIMIT 1`);

async function spärrad(adId) {
  const { rows: [r] } = await pool.query(
    `SELECT ${nyligenKontaktat('a', '$2')} AS spärrad FROM ads a WHERE a.id = $1`,
    [adId, p.id]);
  return r?.spärrad ?? null;
}

let fel = 0;
const kolla = (namn, fick, väntat, info = '') => {
  const ok = fick === väntat;
  if (!ok && fick !== null) fel += 1;
  const svar = fick === null ? 'ingen testdata' : fick ? 'spärrad' : 'tillåten';
  console.log(`${fick === null ? '·' : ok ? '✓' : '✗'} ${namn.padEnd(50)} ${svar}${info ? `  (${info})` : ''}`);
};

// Organisation numbers written to, and when last.
const { rows: skickat } = await pool.query(
  `SELECT a.raw->'employer'->>'organization_number' AS orgnr,
          max(ap.sent_at) AS senast, min(a.employer) AS namn
   FROM applications ap JOIN ads a ON a.id = ap.ad_id
   WHERE ap.profile_id = $1 AND ap.sent_at IS NOT NULL
     AND a.raw->'employer'->>'organization_number' IS NOT NULL
   GROUP BY 1`, [p.id]);
const senast = new Map(skickat.map((r) => [r.orgnr, r]));
const dagar = (t) => Math.floor((Date.now() - new Date(t).getTime()) / 86400000);

// Candidate ads: those some search holds, with their org number and address.
const { rows: kandidater } = await pool.query(
  `SELECT DISTINCT a.id, a.employer, a.apply_email,
          a.raw->'employer'->>'organization_number' AS orgnr
   FROM match_results m JOIN ads a ON a.id = m.ad_id
   WHERE a.raw->'employer'->>'organization_number' IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM applications x WHERE x.ad_id = a.id)`);

const inom = kandidater.find((k) => senast.has(k.orgnr)
  && dagar(senast.get(k.orgnr).senast) < FÖRETAGSPAUS_DAGAR);
kolla('samma orgnr, inget brev till just denna annons', inom ? await spärrad(inom.id) : null, true,
  inom ? `${inom.employer}, förra brevet för ${dagar(senast.get(inom.orgnr).senast)} dagar sedan` : '');

const utanför = kandidater.find((k) => senast.has(k.orgnr)
  && dagar(senast.get(k.orgnr).senast) > FÖRETAGSPAUS_DAGAR);
kolla('samma orgnr, senaste brevet äldre än 30 dagar', utanför ? await spärrad(utanför.id) : null, false,
  utanför ? `${utanför.employer}, förra brevet för ${dagar(senast.get(utanför.orgnr).senast)} dagar sedan` : '');

const aldrig = kandidater.find((k) => !senast.has(k.orgnr)
  && k.apply_email && !/@(gmail|hotmail|outlook)\./i.test(k.apply_email));
kolla('företag som aldrig fått brev', aldrig ? await spärrad(aldrig.id) : null, false,
  aldrig?.employer || '');

const gmail = kandidater.find((k) => !senast.has(k.orgnr) && /@gmail\.com$/i.test(k.apply_email || ''));
kolla('gmail-adress hos företag som aldrig fått brev', gmail ? await spärrad(gmail.id) : null, false,
  gmail?.employer || '');

console.log(fel ? `\n${fel} fall gav fel svar` : '\nalla fall med testdata gav rätt svar');
await pool.end();
process.exit(fel ? 1 : 0);
