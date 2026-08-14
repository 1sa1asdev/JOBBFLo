import { NextResponse } from 'next/server';
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
  const { searchId, approved } = await req.json();
  if (!searchId) return NextResponse.json({ error: 'searchId krävs' }, { status: 400 });
  const s = await approveCampaignLetter(searchId, Boolean(approved));
  return NextResponse.json(s);
}
