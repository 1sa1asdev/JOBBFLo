import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import {
  writeCampaignLetter, previewCampaign, approveCampaignLetter, campaignMessages,
} from '../../../../src/campaign.js';

export const dynamic = 'force-dynamic';

// the letter as it stands, plus how it looks filled in for a real ad
export async function GET(req) {
  const searchId = new URL(req.url).searchParams.get('search');
  if (!searchId) return NextResponse.json({ error: 'search krävs' }, { status: 400 });
  try {
    const [preview, messages] = await Promise.all([
      previewCampaign(searchId),
      campaignMessages(searchId),
    ]);
    return NextResponse.json({ ...preview, messages });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// write it, or revise it from a chat instruction
export async function POST(req) {
  const { searchId, instruction } = await req.json();
  if (!searchId) return NextResponse.json({ error: 'searchId krävs' }, { status: 400 });
  try {
    const letter = await writeCampaignLetter(searchId, instruction?.trim() || null);
    return NextResponse.json(letter);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// approving is what unlocks sending — and any edit clears it again
export async function PATCH(req) {
  const { searchId, approved, letter, subject } = await req.json();
  if (!searchId) return NextResponse.json({ error: 'searchId krävs' }, { status: 400 });

  // Editing the letter by hand. The chat can only ask a model to try
  // again; sometimes the fix is one word, and describing that word
  // costs more than typing it — and the model may change three other
  // things while it is in there.
  if (letter !== undefined || subject !== undefined) {
    const body = String(letter ?? '').trim();
    if (letter !== undefined && !body) {
      return NextResponse.json({ error: 'brevet får inte vara tomt' }, { status: 400 });
    }

    const sets = [];
    const vals = [searchId];
    if (letter !== undefined) { vals.push(body); sets.push(`campaign_letter = $${vals.length}`); }
    if (subject !== undefined) {
      vals.push(String(subject || '').trim().slice(0, 200) || null);
      sets.push(`campaign_subject = $${vals.length}`);
    }
    // An edit un-approves. Approval is consent to the exact text that
    // was on screen, and this is no longer that text — carrying it over
    // would let an edited letter go out having never been read.
    sets.push('campaign_letter_approved_at = NULL');

    const { rows: [row] } = await pool.query(
      `UPDATE searches SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      vals
    );
    if (!row) return NextResponse.json({ error: 'kampanjen finns inte' }, { status: 404 });
    return NextResponse.json(row);
  }

  const s = await approveCampaignLetter(searchId, Boolean(approved));
  return NextResponse.json(s);
}
