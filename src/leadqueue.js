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
// Finds are taken automatically. The confirmation queue is gone: it was
// 338 long and growing faster than anyone empties it, so in practice it
// was a way of not applying rather than review. Hitta adresser stays as
// a place to look and to override, not as a gate.
//
// verifiable() still marks which finds carry their own proof, because
// "180 of 334 were provable" is worth knowing even when all 334 are
// used.
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

  // Accept what carries its own proof, so the campaign gains addresses
  // from this tick rather than gaining a longer list to approve.
  const verified = await confirmVerified();

  return { text, pages: rows.length, named, shared, none, skipped, verified };
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

// ------------------------------------------------------------
// Which finds the campaign may accept without asking.
//
// Two kinds of proof, and one of them has to hold:
//
//   the page named the person — a contact page that says "Martina
//   Nunes, Talent Acquisition" beside the mailto is the employer's own
//   statement about who handles the hire; or
//
//   the domain is the employer's — recruitment@ndpconsult.se on NDP IT's
//   ad is that company, not a third party who happened to appear in the
//   markup. This is the one that carries the volume: 1084 of 2000.
//
// Both require exactly ONE candidate. Two addresses on a page means the
// page did not say which, and picking for the user is precisely the
// guess this bar exists to avoid.
//
// Shared inboxes never qualify. info@ is a real address that reaches a
// real company, and the letter still lands in the queue the ATS was
// built to feed — worth offering, never worth assuming.
// ------------------------------------------------------------
const STOPORD = /(ab|as|asa|oy|hb|kb|group|sweden|sverige|nordic|scandinavia|holding|consulting|international|the)/g;
const bara = (t) => String(t || '').toLowerCase().replace(STOPORD, '').replace(/[^a-z0-9]/g, '');

export function verifiable(scan, ad) {
  if (!scan?.ok || scan.only_shared) return null;
  const kontakter = scan.contacts || [];
  if (kontakter.length !== 1) return null;

  const k = kontakter[0];
  if (!k?.email) return null;
  if (k.name) return { email: k.email, grund: 'namngiven kontaktperson' };

  const domän = bara((k.email.split('@')[1] || '').replace(/\.(se|com|nu|net|org|io|eu|dk|no|fi)$/, ''));
  const arbetsgivare = bara(ad?.employer);
  if (domän && arbetsgivare && (arbetsgivare.includes(domän) || domän.includes(arbetsgivare))) {
    return { email: k.email, grund: 'domänen tillhör arbetsgivaren' };
  }
  return null;
}

// Promotes what clears the bar onto the ad, which is what puts it in
// the campaign's queue. apply_email_source records that a machine did
// this, so a bad rule here stays auditable rather than looking like
// something the user typed.
export async function confirmVerified({ limit = 500 } = {}) {
  const { rows } = await pool.query(
    `SELECT ls.ad_id, ls.contacts, ls.only_shared, ls.ok, a.employer
     FROM lead_scans ls
     JOIN ads a ON a.id = ls.ad_id
     JOIN match_results m ON m.ad_id = a.id
     JOIN searches s ON s.id = m.search_id
     WHERE s.auto_apply_enabled AND s.deleted_at IS NULL
       AND s.campaign_created_at IS NOT NULL
       AND a.apply_email IS NULL AND ls.ok
     GROUP BY ls.ad_id, ls.contacts, ls.only_shared, ls.ok, a.employer
     LIMIT $1`,
    [limit]
  );

  let godkända = 0; let styrkta = 0;
  for (const r of rows) {
    // Proof first, but no longer a gate. The confirmation queue was 338
    // long and growing faster than anyone empties it, which made it a
    // way of not applying rather than a safeguard — so an unproved find
    // is taken too, at the top of the ranking the scanner already
    // applied (named person, then dotted local part, then shared inbox).
    //
    // What still protects the user is downstream and unchanged: union,
    // GDPR and vendor addresses never enter lead_scans at all, and the
    // campaign refuses a second letter to an address already written
    // to. What is given up is the case where a page named the wrong
    // person — that letter now goes out without anyone reading it first.
    const v = verifiable(r, r)
      || (r.contacts?.[0]?.email
        ? { email: r.contacts[0].email, grund: r.only_shared ? 'delad inkorg' : 'enda träffen på sidan' }
        : null);
    if (!v) continue;
    // Last gate before an address becomes something the campaign will
    // mail. Nothing reads these now that confirmation is gone, so a
    // parse artefact reaches Gmail unread — and one that did stopped
    // the campaign rather than the letter.
    if (!/^[^@\s<>\\"',;]+@[^@\s<>\\"',;]+\.[a-z]{2,}$/i.test(v.email)) continue;
    if (v.grund === 'namngiven kontaktperson' || v.grund === 'domänen tillhör arbetsgivaren') {
      styrkta += 1;
    }
    await pool.query(
      `UPDATE ads SET apply_email = $2, apply_email_source = 'scanned'
       WHERE id = $1 AND apply_email IS NULL`,
      [r.ad_id, v.email]
    );
    godkända += 1;
  }
  return { prövade: rows.length, godkända, styrkta };
}
