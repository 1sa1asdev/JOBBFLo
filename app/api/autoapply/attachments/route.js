import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 10 * 1024 * 1024;
// Gmail rejects these outright, and an employer's filter will too
const BLOCKED = /\.(exe|bat|cmd|com|scr|js|jar|msi|vbs|ps1|sh|dll|zip|7z)$/i;

// what will ride along with this campaign's letter
export async function GET(req) {
  const searchId = new URL(req.url).searchParams.get('search');
  if (!searchId) return NextResponse.json({ error: 'search krävs' }, { status: 400 });

  const { rows: [cv] } = await pool.query(
    `SELECT COALESCE(s.cv_filename, p.cv_filename) AS filename,
            octet_length(COALESCE(s.cv_file, p.cv_file)) AS bytes
     FROM searches s JOIN profile p ON p.id = s.profile_id WHERE s.id = $1`,
    [searchId]
  );
  const { rows: extra } = await pool.query(
    `SELECT id, filename, mime, size_bytes, search_id, include_by_default
     FROM attachments
     WHERE profile_id = (SELECT id FROM profile LIMIT 1)
       AND (search_id IS NULL OR search_id = $1)
     ORDER BY created_at`,
    [searchId]
  );

  return NextResponse.json({
    cv: cv?.bytes ? { filename: cv.filename, bytes: Number(cv.bytes) } : null,
    files: extra.map((f) => ({ ...f, size_bytes: Number(f.size_bytes), global: !f.search_id })),
  });
}

export async function POST(req) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    const searchId = form.get('searchId');
    const global = form.get('global') === 'true';
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'ingen fil bifogad' }, { status: 400 });
    }
    const filename = file.name || 'bilaga';
    if (BLOCKED.test(filename)) {
      return NextResponse.json(
        { error: `${filename.split('.').pop()}-filer blockeras av mejlfilter — använd PDF` },
        { status: 400 }
      );
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      return NextResponse.json({ error: 'filen är större än 10 MB' }, { status: 400 });
    }

    const { rows: [p] } = await pool.query(`SELECT id FROM profile LIMIT 1`);
    const { rows: [row] } = await pool.query(
      `INSERT INTO attachments (profile_id, search_id, filename, mime, bytes, size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, filename, size_bytes, search_id`,
      [p.id, global ? null : searchId, filename, file.type || null, bytes, bytes.length]
    );
    return NextResponse.json({ ...row, size_bytes: Number(row.size_bytes), global: !row.search_id });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function DELETE(req) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id krävs' }, { status: 400 });
  await pool.query(`DELETE FROM attachments WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
