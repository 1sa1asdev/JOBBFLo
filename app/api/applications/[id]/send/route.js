import { NextResponse } from 'next/server';
import { sendApplication } from '../../../../../src/mailer.js';

export const dynamic = 'force-dynamic';

// THE approval gate. Only reachable from the user clicking
// "Skicka nu" in the confirm modal — nothing schedules this.
export async function POST(req, { params }) {
  const { id } = await params;
  const { to } = await req.json().catch(() => ({}));
  try {
    const result = await sendApplication(id, { to });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
