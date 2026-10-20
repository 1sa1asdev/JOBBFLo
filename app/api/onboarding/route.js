import { NextResponse } from 'next/server';
import { aktivProfilId } from '../../../src/auth.js';
import { onboardingStatus, avslutaOnboarding } from '../../../src/onboarding.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await onboardingStatus(await aktivProfilId()));
}

// Finished, or skipped to the end — the start page stops sending them here.
export async function POST() {
  const profileId = await aktivProfilId();
  await avslutaOnboarding(profileId);
  return NextResponse.json(await onboardingStatus(profileId));
}
