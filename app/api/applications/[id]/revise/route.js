import { NextResponse } from 'next/server';
import { reviseLetter } from '../../../../../src/letters.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const { instruction } = await req.json();
  if (!instruction?.trim()) return NextResponse.json({ error: 'instruction krävs' }, { status: 400 });
  try {
    const app = await reviseLetter(id, instruction.trim());
    return NextResponse.json(app);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
