import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const { rows: [search] } = await pool.query(
    `SELECT * FROM searches WHERE id = $1 AND deleted_at IS NULL`, [id]
  );
  if (!search) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { rows: messages } = await pool.query(
    `SELECT role, content, created_at FROM search_messages
     WHERE search_id = $1 ORDER BY created_at`, [id]
  );
  return NextResponse.json({ ...search, messages });
}

export async function PATCH(req, { params }) {
  const { id } = await params;
  const body = await req.json();
  const sets = [];
  const vals = [id];

  if ('scan_enabled' in body) { vals.push(body.scan_enabled); sets.push(`scan_enabled = $${vals.length}`); }
  if ('scan_interval' in body) { vals.push(body.scan_interval); sets.push(`scan_interval = $${vals.length}::interval`); }
  if ('name' in body) { vals.push(body.name); sets.push(`name = $${vals.length}`); }
  if ('email_alias' in body) { vals.push(body.email_alias); sets.push(`email_alias = $${vals.length}`); }

  // Location picked in the UI is authoritative: write it into
  // api_filters too, so re-parsing the criteria can't silently
  // discard an explicit choice.
  if ('location' in body) {
    const loc = body.location?.trim() || null;
    vals.push(loc); sets.push(`location = $${vals.length}`);
    vals.push(loc);
    sets.push(loc
      ? `api_filters = jsonb_set(coalesce(api_filters,'{}'::jsonb), '{municipality}', to_jsonb($${vals.length}::text))`
      : `api_filters = (coalesce(api_filters,'{}'::jsonb) - 'municipality')`);
  }
  if ('remote_ok' in body) {
    vals.push(body.remote_ok); sets.push(`remote_ok = $${vals.length}`);
  }
  if (!sets.length) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });

  const { rows: [search] } = await pool.query(
    `UPDATE searches SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`, vals
  );
  return NextResponse.json(search);
}

// soft delete — the inbox back-references searches
export async function DELETE(_req, { params }) {
  const { id } = await params;
  await pool.query(`UPDATE searches SET deleted_at = now() WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
