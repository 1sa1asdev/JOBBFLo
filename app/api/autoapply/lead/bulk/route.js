import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';
import { fingerprint } from '../../../../../src/fetchJobs.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// A pasted list of contacts, checked before anything is written.
//
// Two calls, deliberately. GET-shaped "check" answers "what would this
// do" and writes nothing; POST does it. Adding forty contacts is not a
// thing to discover the consequences of afterwards — especially the
// duplicates, which the campaign would silently skip later for a reason
// only the log explains.
//
// Each contact becomes an ordinary ad with source = 'manual', exactly
// as the single-lead route does. Same reasoning: everything downstream
// already works on ads.
// ------------------------------------------------------------

const GILTIG = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function granska(profileId, kontakter) {
  const adresser = kontakter.map((k) => String(k.email || '').trim().toLowerCase());

  // One query for the whole list rather than one per row: forty
  // contacts should not mean forty round trips, and the answer is the
  // same shape either way.
  const { rows: kontaktade } = await pool.query(
    `SELECT lower(a.sent_to) AS email, ads.employer, a.sent_at
     FROM applications a JOIN ads ON ads.id = a.ad_id
     WHERE a.profile_id = $1 AND a.sent_to IS NOT NULL
       AND lower(a.sent_to) = ANY($2::text[])`,
    [profileId, adresser]
  );
  const redan = new Map(kontaktade.map((r) => [r.email, r]));

  const sedda = new Set();
  return kontakter.map((k) => {
    const email = String(k.email || '').trim().toLowerCase();
    const employer = String(k.employer || '').trim();

    let status = 'ok'; let detalj = null;
    if (!GILTIG.test(email)) { status = 'ogiltig'; detalj = 'ser inte ut som en adress'; }
    else if (!employer) { status = 'saknar_arbetsgivare'; detalj = 'fyll i vem det är'; }
    else if (sedda.has(email)) { status = 'dubblett'; detalj = 'finns redan i listan'; }
    else if (redan.has(email)) {
      const r = redan.get(email);
      status = 'redan_kontaktad';
      detalj = `${r.employer}${r.sent_at ? `, ${new Date(r.sent_at).toLocaleDateString('sv-SE')}` : ''}`;
    }
    sedda.add(email);
    return { ...k, email, employer, status, detalj };
  });
}

// Check only. Writes nothing.
export async function PUT(req) {
  const { contacts } = await req.json();
  if (!Array.isArray(contacts)) {
    return NextResponse.json({ error: 'contacts krävs' }, { status: 400 });
  }
  const { rows: [p] } = await pool.query(`SELECT id FROM profile LIMIT 1`);
  return NextResponse.json({ contacts: await granska(p.id, contacts) });
}

export async function POST(req) {
  const { searchId, contacts } = await req.json();
  if (!searchId) return NextResponse.json({ error: 'searchId krävs' }, { status: 400 });
  if (!Array.isArray(contacts) || !contacts.length) {
    return NextResponse.json({ error: 'inga kontakter' }, { status: 400 });
  }

  const { rows: [search] } = await pool.query(
    `SELECT s.id, s.profile_id FROM searches s
     WHERE s.id = $1 AND s.deleted_at IS NULL AND s.campaign_created_at IS NOT NULL`,
    [searchId]
  );
  if (!search) return NextResponse.json({ error: 'kampanjen finns inte' }, { status: 404 });

  // Re-checked here rather than trusting what the client reviewed. The
  // list may have sat on screen for a while, and the campaign could
  // have written to one of these addresses in the meantime.
  const granskade = await granska(search.profile_id, contacts);
  const godkända = granskade.filter((k) => k.status === 'ok');

  const tillagda = [];
  for (const k of godkända) {
    const headline = String(k.title || '').trim() || `Spontanansökan — ${k.employer}`;
    const { rows: [ad] } = await pool.query(
      `INSERT INTO ads (source, external_id, fingerprint, title, employer, employer_type,
         description, apply_email, apply_email_source, municipality, published_at)
       VALUES ('manual', NULL, $1, $2, $3, 'private', $4, $5, 'manual', $6, now())
       RETURNING id, employer, apply_email`,
      [fingerprint({ employer: k.employer, title: headline, municipality: k.municipality || null }),
       headline, k.employer,
       k.person
         ? `Lead tillagd för hand. Kontaktperson: ${k.person}. Ingen annonstext finns — kampanjbrevet skickas som det är.`
         : 'Lead tillagd för hand. Ingen annonstext finns — kampanjbrevet skickas som det är.',
       k.email, String(k.municipality || '').trim() || null]
    );
    await pool.query(
      `INSERT INTO match_results (search_id, ad_id, queued_at)
       VALUES ($1, $2, now()) ON CONFLICT (search_id, ad_id) DO NOTHING`,
      [searchId, ad.id]
    );
    tillagda.push(ad);
  }

  return NextResponse.json({
    tillagda: tillagda.length,
    // The ones that did not go in, and why. Returned rather than
    // swallowed: "38 of 40 added" without saying which two is the
    // failure this whole review step exists to prevent.
    avvisade: granskade.filter((k) => k.status !== 'ok'),
  }, { status: 201 });
}
