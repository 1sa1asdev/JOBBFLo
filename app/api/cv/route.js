import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';
import { extractCvText, looksLikeCv } from '../../../src/cv.js';
import { refreshCvProfile } from '../../../src/cvprofile.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// CV upload. Two targets:
//   (no searchId)  -> profile.cv_text   — the base CV
//   (searchId)     -> searches.cv_text  — a version tailored for
//                     that search, used instead of the base one
// ------------------------------------------------------------
export async function POST(req) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    const searchId = form.get('searchId') || null;
    const pastedText = form.get('text');

    let text;
    let filename;
    let bytes = null;   // kept so the CV can be ATTACHED when applying
    let mime = null;

    if (pastedText && String(pastedText).trim()) {
      text = String(pastedText).trim();
      filename = 'inklistrad text';
      // pasted text has no file to attach — the UI warns about this
    } else {
      if (!file || typeof file.arrayBuffer !== 'function') {
        return NextResponse.json({ error: 'ingen fil bifogad' }, { status: 400 });
      }
      filename = file.name || 'cv';
      bytes = Buffer.from(await file.arrayBuffer());
      mime = file.type || null;
      text = await extractCvText(bytes, filename);
    }

    const check = looksLikeCv(text);

    if (searchId) {
      const { rows: [s] } = await pool.query(
        `UPDATE searches SET cv_text = $2, cv_filename = $3, cv_file = $4, cv_mime = $5
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, name, cv_filename`,
        [searchId, text, filename, bytes, mime]
      );
      if (!s) return NextResponse.json({ error: 'sökningen hittades inte' }, { status: 404 });
      // One read of the new CV, in the background. The upload responds
      // immediately; the profile lands a few seconds later.
      refreshCvProfile({ searchId }).catch((e) => console.error('cv-profil:', e.message));
      return NextResponse.json({
        scope: 'search', search: s.name, filename, chars: text.length,
        attachable: Boolean(bytes),
        warning: check.ok ? null : check.why,
      });
    }

    const { rows: [p] } = await pool.query(
      `UPDATE profile SET cv_text = $1, cv_filename = $2, cv_file = $3, cv_mime = $4,
         cv_uploaded_at = now(), updated_at = now()
       WHERE id = (SELECT id FROM profile LIMIT 1)
       RETURNING id, cv_filename`,
      [text, filename, bytes, mime]
    );
    if (!p) return NextResponse.json({ error: 'ingen profil' }, { status: 404 });

    // Understand the CV once, now, rather than re-deriving it inside
    // every future scoring and letter call.
    refreshCvProfile().catch((e) => console.error('cv-profil:', e.message));

    return NextResponse.json({
      scope: 'profile', filename, chars: text.length,
      attachable: Boolean(bytes),
      warning: check.ok ? null : check.why,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

// remove a search-specific CV (fall back to the profile one)
export async function DELETE(req) {
  const searchId = new URL(req.url).searchParams.get('search');
  if (!searchId) return NextResponse.json({ error: 'search krävs' }, { status: 400 });
  await pool.query(
    `UPDATE searches SET cv_text = NULL, cv_filename = NULL WHERE id = $1`, [searchId]
  );
  return NextResponse.json({ ok: true });
}

// what CV is in play right now, and can it actually be attached?
export async function GET(req) {
  const searchId = new URL(req.url).searchParams.get('search');
  const { rows: [p] } = await pool.query(
    `SELECT cv_filename, cv_uploaded_at, length(cv_text) AS chars,
            octet_length(cv_file) AS file_bytes FROM profile LIMIT 1`
  );
  let search = null;
  if (searchId) {
    const { rows: [s] } = await pool.query(
      `SELECT cv_filename, length(cv_text) AS chars, octet_length(cv_file) AS file_bytes
       FROM searches WHERE id = $1`, [searchId]
    );
    search = s?.chars
      ? { filename: s.cv_filename, chars: Number(s.chars), attachable: Boolean(s.file_bytes), size: Number(s.file_bytes || 0) }
      : null;
  }
  return NextResponse.json({
    profile: p?.chars
      ? { filename: p.cv_filename, chars: Number(p.chars), uploaded_at: p.cv_uploaded_at,
          attachable: Boolean(p.file_bytes), size: Number(p.file_bytes || 0) }
      : null,
    search,
    active: search ? 'search' : (p?.chars ? 'profile' : 'none'),
  });
}
