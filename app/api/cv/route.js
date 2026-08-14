import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';
import { extractCvText, looksLikeCv } from '../../../src/cv.js';

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

    if (pastedText && String(pastedText).trim()) {
      text = String(pastedText).trim();
      filename = 'inklistrad text';
    } else {
      if (!file || typeof file.arrayBuffer !== 'function') {
        return NextResponse.json({ error: 'ingen fil bifogad' }, { status: 400 });
      }
      filename = file.name || 'cv';
      text = await extractCvText(Buffer.from(await file.arrayBuffer()), filename);
    }

    const check = looksLikeCv(text);

    if (searchId) {
      const { rows: [s] } = await pool.query(
        `UPDATE searches SET cv_text = $2, cv_filename = $3
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, name, cv_filename`,
        [searchId, text, filename]
      );
      if (!s) return NextResponse.json({ error: 'sökningen hittades inte' }, { status: 404 });
      return NextResponse.json({
        scope: 'search', search: s.name, filename, chars: text.length,
        warning: check.ok ? null : check.why,
      });
    }

    const { rows: [p] } = await pool.query(
      `UPDATE profile SET cv_text = $1, cv_filename = $2, cv_uploaded_at = now(), updated_at = now()
       WHERE id = (SELECT id FROM profile LIMIT 1)
       RETURNING id, cv_filename`,
      [text, filename]
    );
    if (!p) return NextResponse.json({ error: 'ingen profil' }, { status: 404 });

    return NextResponse.json({
      scope: 'profile', filename, chars: text.length,
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

// what CV is in play right now?
export async function GET(req) {
  const searchId = new URL(req.url).searchParams.get('search');
  const { rows: [p] } = await pool.query(
    `SELECT cv_filename, cv_uploaded_at, length(cv_text) AS chars FROM profile LIMIT 1`
  );
  let search = null;
  if (searchId) {
    const { rows: [s] } = await pool.query(
      `SELECT cv_filename, length(cv_text) AS chars FROM searches WHERE id = $1`, [searchId]
    );
    search = s?.chars ? { filename: s.cv_filename, chars: Number(s.chars) } : null;
  }
  return NextResponse.json({
    profile: p?.chars ? { filename: p.cv_filename, chars: Number(p.chars), uploaded_at: p.cv_uploaded_at } : null,
    search,
    active: search ? 'search' : (p?.chars ? 'profile' : 'none'),
  });
}
