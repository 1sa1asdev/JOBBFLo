import { NextResponse } from 'next/server';
import { chatTurn } from '../../../../../src/chat.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const { message } = await req.json();
  if (!message?.trim()) return NextResponse.json({ error: 'message krävs' }, { status: 400 });

  try {
    const result = await chatTurn(id, message.trim());
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
