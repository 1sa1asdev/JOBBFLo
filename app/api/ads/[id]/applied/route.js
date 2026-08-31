import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// "I applied to this one" — straight from the card.
//
// The sibling route under /api/applications/[id]/external needs a row
// to already exist, which means writing a letter first. For a link-only
// ad that is the wrong way round: you apply on the employer's site, in
// their form, and the letter this app would write is often never used.
// Forcing a draft just to have something to mark made the majority case
// (61% of favourites publish no apply_email) the clumsiest one.
//
// So the row is created here, letter and all left null — nothing in the
// schema requires them, because an application is a real-world event
// first and a document second.
//
// Still not a send. Nothing leaves the machine.
// ------------------------------------------------------------
export async function POST(req, { params }) {
  const { id } = await params;
  const { searchId = null } = await req.json().catch(() => ({}));

  const { rows: [ad] } = await pool.query(
    `SELECT id, apply_url, apply_email FROM ads WHERE id = $1`, [id]);
  if (!ad) return NextResponse.json({ error: 'annonsen finns inte' }, { status: 404 });

  const { rows: [profile] } = await pool.query(`SELECT id FROM profile LIMIT 1`);
  if (!profile) return NextResponse.json({ error: 'ingen profil' }, { status: 400 });

  // One application per ad, forever (CLAUDE.md #1) — enforced by
  // UNIQUE(profile_id, ad_id), the multi-user-ready form of it, which
  // is what the conflict target has to name. The WHERE on the update stops
  // this from resetting sent_at on something already sent — a second
  // click must not restart the follow-up clock.
  const { rows: [app] } = await pool.query(
    `INSERT INTO applications
       (ad_id, profile_id, origin_search_id, status, sent_by, sent_at, applied_via_url)
     VALUES ($1, $2, $3, 'sent', 'external', now(), $4)
     ON CONFLICT (profile_id, ad_id) DO UPDATE SET
       status = 'sent', sent_by = 'external', sent_at = now(),
       origin_search_id = COALESCE(applications.origin_search_id, EXCLUDED.origin_search_id),
       applied_via_url = EXCLUDED.applied_via_url, updated_at = now()
     WHERE applications.status = 'drafted'
     RETURNING id, ad_id, status, sent_by, sent_at, applied_via_url`,
    [id, profile.id, searchId, ad.apply_url || null]
  );

  if (!app) {
    return NextResponse.json({ error: 'redan markerad som ansökt' }, { status: 409 });
  }
  return NextResponse.json(app);
}

// ------------------------------------------------------------
// Undo. A one-click action needs one, and this one is easy to hit by
// mistake on a dense list.
//
// Only ever removes a row this route could have made: marked external,
// with no letter written and no mail in the thread. Anything the user
// actually composed or the app actually sent is off limits — losing a
// sent application's history is not an undo, it is data loss.
// ------------------------------------------------------------
export async function DELETE(req, { params }) {
  const { id } = await params;
  const { rowCount } = await pool.query(
    `DELETE FROM applications a
     WHERE a.ad_id = $1
       AND a.sent_by = 'external'
       AND a.letter_text IS NULL
       AND NOT EXISTS (SELECT 1 FROM email_messages m WHERE m.application_id = a.id)`,
    [id]
  );
  if (!rowCount) {
    // "Nothing to undo" and "refusing to undo" are different answers,
    // and reporting the second for the first sent me hunting a bug that
    // was not there.
    const { rows: [still] } = await pool.query(
      `SELECT 1 FROM applications WHERE ad_id = $1`, [id]);
    return still
      ? NextResponse.json(
          { error: 'går inte att ångra — ansökan har ett brev eller en mejltråd' },
          { status: 409 })
      : NextResponse.json({ error: 'ingen markering att ångra' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
