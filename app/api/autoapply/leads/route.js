import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { scanForEmails, blockedBy } from '../../../../src/leadscan.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// The ads a campaign cannot reach — and the work of making them
// reachable.
//
// 1082 of this campaign's 1149 ads publish no address, so the campaign
// skips them entirely. They are not bad matches; they are unreachable
// ones, and that is the single largest thing standing between the user
// and more applications.
//
// Ordered by embedding distance so the work starts where it pays. The
// user is going to open these pages one at a time, so the order is the
// whole difference between an hour well spent and an hour wasted.
// ------------------------------------------------------------
export async function GET(req) {
  const searchId = new URL(req.url).searchParams.get('search');
  if (!searchId) return NextResponse.json({ error: 'search krävs' }, { status: 400 });

  const { rows: [s] } = await pool.query(
    `SELECT query_embedding FROM searches WHERE id = $1`, [searchId]);

  // Ads with a contact already found come first — those are one click
  // from being reachable — and CV similarity orders within that.
  const order = s?.query_embedding
    ? `ORDER BY (ls.ad_id IS NULL), (a.embedding IS NULL),
                a.embedding <=> $2::vector, a.published_at DESC NULLS LAST`
    : `ORDER BY (ls.ad_id IS NULL), a.published_at DESC NULLS LAST`;
  const args = s?.query_embedding ? [searchId, s.query_embedding] : [searchId];

  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.employer, a.municipality, a.apply_url, a.deadline,
            m.score, a.ats_vendor,
            split_part(split_part(a.apply_url, '://', 2), '/', 1) AS host,
            -- Already known: read from the ad text, or from a page read
            -- earlier. Re-fetching what we have would be slow for the
            -- user and rude to the server.
            ls.contacts AS found, ls.only_shared, ls.host AS found_via
     FROM match_results m
     JOIN ads a ON a.id = m.ad_id
     LEFT JOIN lead_scans ls ON ls.ad_id = a.id
     WHERE m.search_id = $1
       AND a.apply_email IS NULL
       AND a.apply_url IS NOT NULL
       AND a.removed_at IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
     ${order}
     LIMIT 60`,
    args
  );

  const { rows: [n] } = await pool.query(
    `SELECT count(*)::int AS total FROM match_results m JOIN ads a ON a.id = m.ad_id
     WHERE m.search_id = $1 AND a.apply_email IS NULL AND a.apply_url IS NOT NULL
       AND a.removed_at IS NULL AND (a.deadline IS NULL OR a.deadline >= current_date)`,
    [searchId]
  );

  // Marked in the list, not discovered on click: a button that always
  // refuses is worse than one that is not offered.
  const leads = rows.map((r) => ({ ...r, blocked: blockedBy(r.apply_url) }));

  return NextResponse.json({
    leads,
    total: n.total,
    blocked: leads.filter((l) => l.blocked).length,
    ranked: Boolean(s?.query_embedding),
  });
}

// Read one page and report what it found. Writes nothing: an address off
// a page can be a support desk or the wrong person entirely, so it is a
// suggestion for the user to confirm, never something to mail on.
export async function POST(req) {
  const { adId } = await req.json();
  const { rows: [ad] } = await pool.query(
    `SELECT apply_url FROM ads WHERE id = $1`, [adId]);
  if (!ad) return NextResponse.json({ error: 'annonsen finns inte' }, { status: 404 });

  return NextResponse.json(await scanForEmails(ad.apply_url));
}

// The user confirms an address. From here the ad is an ordinary
// mailable candidate: the campaign's own rules — score, threshold,
// per-address dedupe — apply to it unchanged.
export async function PATCH(req) {
  const { adId, email, source = 'scanned' } = await req.json();
  const addr = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
    return NextResponse.json({ error: 'ogiltig mejladress' }, { status: 400 });
  }

  // Same guard the campaign uses at send time, applied while the user is
  // looking at it — better than accepting the address and having the ad
  // skipped later for a reason only the log explains.
  const { rows: [clash] } = await pool.query(
    `SELECT ads.employer FROM applications a JOIN ads ON ads.id = a.ad_id
     WHERE a.sent_to IS NOT NULL AND lower(a.sent_to) = $1`, [addr]);
  if (clash) {
    return NextResponse.json(
      { error: `${addr} har redan fått en ansökan (${clash.employer}).` }, { status: 409 });
  }

  const { rows: [ad] } = await pool.query(
    `UPDATE ads
       SET apply_email = $2,
           apply_email_source = $3,
           apply_email_found_at = now()
     WHERE id = $1 AND apply_email IS NULL
     RETURNING id, employer, apply_email`,
    [adId, addr, source === 'manual' ? 'manual' : 'scanned']
  );
  if (!ad) {
    return NextResponse.json({ error: 'annonsen har redan en adress' }, { status: 409 });
  }
  return NextResponse.json(ad);
}
