import { NextResponse } from 'next/server';
import { aktivProfilId } from '../../../src/auth.js';
import { onboardingStatus, avslutaOnboarding, framsteg } from '../../../src/onboarding.js';

export const dynamic = 'force-dynamic';

// What is set up, and how far into using the app the user is — the
// first-run guide reads the first half, the "Kom igång" panel both.
export async function GET() {
  const profileId = await aktivProfilId();
  const status = await onboardingStatus(profileId);
  return NextResponse.json(status && { ...status, framsteg: await framsteg(profileId) });
}

// Finished, or skipped to the end — the start page stops sending them here.
export async function POST() {
  const profileId = await aktivProfilId();
  await avslutaOnboarding(profileId);
  return NextResponse.json(await onboardingStatus(profileId));
}
