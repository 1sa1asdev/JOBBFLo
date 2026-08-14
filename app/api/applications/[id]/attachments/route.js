import { NextResponse } from 'next/server';
import { attachmentsFor } from '../../../../../src/mailer.js';

export const dynamic = 'force-dynamic';

// What will actually be attached when this application is sent —
// so the send gate can state it rather than the user finding out
// afterwards that only a letter went.
export async function GET(_req, { params }) {
  const { id } = await params;
  try {
    const files = await attachmentsFor(id);
    return NextResponse.json({
      files: files.map((f) => ({ filename: f.filename, size: f.content?.length || 0 })),
      count: files.length,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
