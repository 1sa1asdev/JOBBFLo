import { NextResponse } from 'next/server';
import { currentProfile } from '../../../../src/auth.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const profile = await currentProfile();
    return NextResponse.json({ name: profile.name, email: profile.account_email });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
