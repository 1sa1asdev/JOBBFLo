import { NextResponse } from 'next/server';
import { ägareAvSökning, inteHittad } from '../../../../../src/auth.js';
import { chatTurn } from '../../../../../src/chat.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const profileId = await ägareAvSökning(id);
  if (!profileId) return inteHittad('sökningen finns inte');
  const { message } = await req.json();
  if (!message?.trim()) return NextResponse.json({ error: 'message krävs' }, { status: 400 });

  try {
    const result = await chatTurn(id, message.trim());
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
