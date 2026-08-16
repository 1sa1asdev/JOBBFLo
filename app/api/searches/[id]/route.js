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
    // Same binding rule as Omfattning below: only push a parameter the
    // branch will actually reference. Pushing one unconditionally made
    // the ✕ (clear Ort) button a 500 — Postgres rejects a bind carrying
    // more parameters than the statement has placeholders.
    if (loc) {
      vals.push(loc);
      sets.push(`api_filters = jsonb_set(coalesce(api_filters,'{}'::jsonb), '{municipality}', to_jsonb($${vals.length}::text))`);
    } else {
      sets.push(`api_filters = (coalesce(api_filters,'{}'::jsonb) - 'municipality')`);
    }
  }
  // Omfattning picked explicitly, for the same reason Ort is: this is
  // exactly the filter the model got wrong — it emitted "part-time"
  // into employment-type, an axis that means contract length, and the
  // API answered 0 hits with no error. A picker writes the right label
  // into the right key and cannot be re-interpreted away.
  if ('worktime' in body) {
    const v = body.worktime;
    if (v != null && !['Heltid', 'Deltid'].includes(v)) {
      return NextResponse.json({ error: `okänd omfattning: ${v}` }, { status: 400 });
    }
    // Only bind a parameter when the branch actually uses one —
    // Postgres rejects a bind with more parameters than placeholders,
    // so pushing unconditionally made "Alla" a 500 instead of a clear.
    if (v) {
      vals.push(v);
      sets.push(`api_filters = jsonb_set(coalesce(api_filters,'{}'::jsonb), '{worktime-extent}', to_jsonb($${vals.length}::text))`);
    } else {
      sets.push(`api_filters = (coalesce(api_filters,'{}'::jsonb) - 'worktime-extent')`);
    }
  }
  if ('remote_ok' in body) {
    vals.push(body.remote_ok); sets.push(`remote_ok = $${vals.length}`);
  }
  // Which application methods are worth scoring. Validated here rather
  // than trusted: the column has a CHECK, and a 500 from a constraint
  // violation is a worse answer than a 400.
  if ('apply_filter' in body) {
    if (!['email', 'any', 'external'].includes(body.apply_filter)) {
      return NextResponse.json(
        { error: `okänt ansökningssätt: ${body.apply_filter}` }, { status: 400 }
      );
    }
    vals.push(body.apply_filter); sets.push(`apply_filter = $${vals.length}`);
  }
  // Changing a filter changes the result set, so the pagination cursor
  // is meaningless — reset it and let the next scan re-walk from the
  // top. Without this, editing Ort saved the value but the list kept
  // showing the old page, which reads as "the filter does nothing".
  const filterChanged = 'location' in body || 'remote_ok' in body || 'worktime' in body;
  if (filterChanged) {
    sets.push('fetch_offset = 0', 'fetch_total = NULL', 'fetch_done_at = NULL',
              'dropped_filters = NULL');
  }

  if (!sets.length) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });

  const { rows: [search] } = await pool.query(
    `UPDATE searches SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`, vals
  );

  // Re-find immediately on a filter change. Free — no model involved.
  if (filterChanged) {
    const { scanSearch } = await import('../../../../src/score.js');
    scanSearch(id, { pages: 2 }).catch((e) => console.error(`refetch ${id}:`, e.message));
  }

  return NextResponse.json(search);
}

// soft delete — the inbox back-references searches
export async function DELETE(_req, { params }) {
  const { id } = await params;
  await pool.query(`UPDATE searches SET deleted_at = now() WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
