import { pool } from './db.js';
import { scanForEmails, blockedBy } from './leadscan.js';
import { extractFromText } from './textcontacts.js';

// ------------------------------------------------------------
// Finding addresses is part of running a campaign.
//
// A campaign splits its pool the moment it looks at it: ads that
// publish an address, and ads that publish a link. The second group is
// 94% of one campaign here — 1144 of 1215 — and it was the user's job
// to work through by hand, which meant the campaign sat idle looking
// broken while its actual bottleneck went untouched.
//
// So the split itself starts the work. Two sources, cheapest first:
//
//   1. the ad text Arbetsförmedlingen already gave us — no network at
//      all, and it covers about a quarter of the pool
//   2. the application page, for what is left
//
// CAMPAIGNS ONLY. A saved search must never cause this app to fetch
// anybody's servers; it is a standing rule here, and this is the code
// most likely to break it, so the query joins searches and tests
// auto_apply_enabled rather than taking a search id on trust.
//
// Nothing found is ever used to send. Every hit lands in lead_scans as
// a suggestion and waits for the user to confirm it in Hitta adresser —
// an address off a page can be a support desk or the wrong person, and
// these are letters to strangers.
// ------------------------------------------------------------

// Small on purpose. Each page is a request to somebody else's server,
// the scanner already waits a second between hits on one host, and
// there is no deadline: the results sit until the user looks at them.
const PAGES_PER_TICK = 12;

export async function scanCampaignLeads({ pages = PAGES_PER_TICK } = {}) {
  // Step one is free and covers the most ground, so it runs to
  // completion before a single page is fetched. Scoped per campaign
  // even though it touches no network: "campaigns only" is a rule about
  // whose ads this app works on, not only about who it calls.
  const { rows: kampanjer } = await pool.query(
    `SELECT id FROM searches
     WHERE auto_apply_enabled AND deleted_at IS NULL AND campaign_created_at IS NOT NULL`
  );
  const text = { scanned: 0, named: 0, onlyShared: 0, none: 0 };
  for (const k of kampanjer) {
    const r = await extractFromText({ searchId: k.id, limit: 400 });
    for (const key of Object.keys(text)) text[key] += r[key] || 0;
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (a.id) a.id, a.apply_url, s.name AS kampanj
     FROM searches s
     JOIN match_results m ON m.search_id = s.id
     JOIN ads a ON a.id = m.ad_id
     LEFT JOIN lead_scans ls ON ls.ad_id = a.id
     WHERE s.auto_apply_enabled            -- campaigns, never plain searches
       AND s.deleted_at IS NULL
       AND s.campaign_created_at IS NOT NULL
       AND a.apply_email IS NULL
       AND a.apply_url IS NOT NULL
       AND a.removed_at IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
       AND ls.ad_id IS NULL                -- never read one page twice
       -- Worth the request in the order the user would pick: a scoring
       -- verdict already paid for means this ad matters.
     ORDER BY a.id, m.score DESC NULLS LAST
     LIMIT $1`,
    [pages]
  );

  let named = 0; let shared = 0; let none = 0; let skipped = 0;
  for (const ad of rows) {
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

    if (r.ok && !r.onlyShared) named += 1;
    else if (r.ok) shared += 1;
    else none += 1;
  }

  return { text, pages: rows.length, named, shared, none, skipped };
}

// How much of a campaign is waiting on an address, and how far the
// scan has got. The card says "1144 utan mejladress" — this is what
// turns that from a dead end into progress the user can watch.
export async function leadProgress(searchId) {
  const { rows: [r] } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE a.apply_email IS NULL) AS utan_adress,
       count(*) FILTER (WHERE a.apply_email IS NULL AND ls.ad_id IS NOT NULL) AS lasta,
       count(*) FILTER (WHERE a.apply_email IS NULL AND ls.ok) AS att_bekrafta
     FROM match_results m
     JOIN ads a ON a.id = m.ad_id
     LEFT JOIN lead_scans ls ON ls.ad_id = a.id
     WHERE m.search_id = $1
       AND a.removed_at IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)`,
    [searchId]
  );
  const n = (v) => Number(v || 0);
  return { utanAdress: n(r?.utan_adress), lasta: n(r?.lasta), attBekrafta: n(r?.att_bekrafta) };
}
