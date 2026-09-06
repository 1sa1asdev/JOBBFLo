// Read every unaddressed ad in a campaign, one at a time, and cache what
// each page yielded.
//
// Sequential on purpose. These are other people's servers, the scanner
// already waits a second between hits on one host, and there is no
// deadline here — the results sit in lead_scans until the user looks.
//
// Writes nothing to ads.apply_email. Every finding stays a suggestion
// until confirmed in the UI, which is the whole shape of this feature.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { scanForEmails, blockedBy } from '../src/leadscan.js';

const searchId = process.argv[2];
const filter = process.argv[3] || null;   // optional substring, e.g. teamtailor
if (!searchId) {
  console.error('användning: node scripts/scan-leads.js <searchId> [domänfilter]');
  process.exit(1);
}

const { rows: ads } = await pool.query(
  `SELECT a.id, a.employer, a.apply_url
   FROM match_results m
   JOIN ads a ON a.id = m.ad_id
   LEFT JOIN lead_scans ls ON ls.ad_id = a.id
   WHERE m.search_id = $1
     AND a.apply_email IS NULL
     AND a.apply_url IS NOT NULL
     AND a.removed_at IS NULL
     AND (a.deadline IS NULL OR a.deadline >= current_date)
     AND ls.ad_id IS NULL
     AND ($2::text IS NULL OR a.apply_url ILIKE '%' || $2 || '%')
   ORDER BY a.published_at DESC NULLS LAST`,
  [searchId, filter]
);

console.log(`${ads.length} annonser att läsa${filter ? ` (${filter})` : ''}`);

let named = 0; let shared = 0; let none = 0; let skipped = 0;
for (const [i, ad] of ads.entries()) {
  if (blockedBy(ad.apply_url)) { skipped += 1; continue; }

  let r;
  try { r = await scanForEmails(ad.apply_url); }
  catch (err) { r = { ok: false, reason: String(err?.message || err).slice(0, 120) }; }

  await pool.query(
    `INSERT INTO lead_scans (ad_id, ok, contacts, only_shared, reason, host)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6)
     ON CONFLICT (ad_id) DO UPDATE SET
       ok = EXCLUDED.ok, contacts = EXCLUDED.contacts,
       only_shared = EXCLUDED.only_shared, reason = EXCLUDED.reason,
       host = EXCLUDED.host, scanned_at = now()`,
    [ad.id, Boolean(r.ok), JSON.stringify(r.contacts || []),
     Boolean(r.onlyShared), r.reason || null, r.host || null]
  );

  if (r.ok && !r.onlyShared) { named += 1; } else if (r.ok) { shared += 1; } else { none += 1; }

  const who = r.contacts?.[0];
  console.log(`  ${String(i + 1).padStart(3)}/${ads.length}  `
    + `${String(ad.employer).slice(0, 24).padEnd(26)}`
    + (r.ok ? `${who.email}${who.name ? `  (${who.name})` : ''}${r.onlyShared ? '  [delad]' : ''}`
            : `— ${String(r.reason).slice(0, 40)}`));
}

console.log(`\nklart: ${named} med kontaktperson, ${shared} delad inkorg, `
  + `${none} utan träff, ${skipped} överhoppade`);
await pool.end();
