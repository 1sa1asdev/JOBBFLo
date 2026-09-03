import { NextResponse } from 'next/server';
import { attachmentsFor } from '../../../../../src/mailer.js';
import { pool } from '../../../../../src/db.js';
import { extractCvText } from '../../../../../src/cv.js';

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

const MAX_BYTES = 10 * 1024 * 1024;

// ------------------------------------------------------------
// Swap the CV for THIS letter only.
//
// A care job and a dev job want different documents, and both can live
// in the same search — so the choice belongs to the application, not to
// the search it came from.
//
// The extracted text is stored alongside the bytes because the letter is
// written FROM the CV: keeping only the attachment would let the
// document and the prose describe different people, with the letter
// arguing from experience the attached CV never mentions.
// ------------------------------------------------------------
export async function POST(req, { params }) {
  const { id } = await params;
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'ingen fil bifogad' }, { status: 400 });
    }

    const filename = file.name || 'cv';
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      return NextResponse.json({ error: 'filen är större än 10 MB' }, { status: 400 });
    }
    const text = await extractCvText(bytes, filename);

    const { rows: [app] } = await pool.query(
      `UPDATE applications
         SET cv_file = $2, cv_filename = $3, cv_mime = $4, cv_text = $5, updated_at = now()
       WHERE id = $1 AND status = 'drafted'
       RETURNING id, cv_filename`,
      [id, bytes, filename, file.type || null, text]
    );
    // Refused once sent: the attachment is then a record of what was
    // actually posted, and changing it would make the app disagree with
    // the employer's inbox.
    if (!app) {
      return NextResponse.json(
        { error: 'går bara att byta på ett utkast — ansökan är redan skickad' },
        { status: 409 }
      );
    }
    return NextResponse.json({ filename: app.cv_filename, chars: text.length });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

// Back to the search's or the profile's CV.
export async function DELETE(_req, { params }) {
  const { id } = await params;
  const { rows: [app] } = await pool.query(
    `UPDATE applications
       SET cv_file = NULL, cv_filename = NULL, cv_mime = NULL, cv_text = NULL,
           updated_at = now()
     WHERE id = $1 AND status = 'drafted' RETURNING id`,
    [id]
  );
  if (!app) {
    return NextResponse.json(
      { error: 'går bara att ändra på ett utkast' }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
