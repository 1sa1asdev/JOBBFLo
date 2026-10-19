import { NextResponse } from 'next/server';
import { ägareAvAnsökan, inteHittad } from '../../../../../src/auth.js';
import { sendApplication } from '../../../../../src/mailer.js';

export const dynamic = 'force-dynamic';

// THE approval gate. Only reachable from the user clicking
// "Skicka nu" in the confirm modal — nothing schedules this.
export async function POST(req, { params }) {
  const { id } = await params;
  const profileId = await ägareAvAnsökan(id);
  if (!profileId) return inteHittad('ansökan finns inte');
  const { to } = await req.json().catch(() => ({}));
  try {
    const result = await sendApplication(id, { to });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
