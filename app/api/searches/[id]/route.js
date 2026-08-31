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
    // Accepts a list now — "Linköping och Stockholm" is one search, not
    // two. A bare string still works, because older callers send one.
    const picked = [...new Set(
      [].concat(body.location ?? [])
        .map((s) => String(s).trim())
        .filter(Boolean)
    )];

    vals.push(picked.length ? picked : null);
    sets.push(`location = $${vals.length}::text[]`);

    // A place is either a kommun or a län, and they are different
    // parameters to JobSearch. Sending "Stockholms län" as a
    // municipality resolves to nothing and quietly degrades into free
    // text, so each name is routed by what the taxonomy says it is.
    // Classified by EXACT label, not by resolveConcept. That helper
    // deliberately strips a trailing " län" and retries, which is the
    // right kindness when looking a name up but the wrong answer when
    // deciding what a name IS: it made "Stockholms län" resolve to the
    // Stockholm municipality — the city instead of the county, quietly
    // dropping every job in the other 25 kommuner.
    const muni = [];
    const reg = [];
    if (picked.length) {
      const { loadTaxonomy } = await import('../../../../src/taxonomy.js');
      const tax = await loadTaxonomy();
      for (const name of picked) {
        const key = name.toLowerCase();
        // The region map is EURES-wide and carries bare city names from
        // across Europe — "Stockholm" and "Uppsala" are both a kommun
        // AND a region in it. Membership alone therefore classifies
        // Swedish cities as counties and loses the actual municipality.
        // A Swedish län always ends in " län", which is the same test
        // /api/locations uses to build the picker, so the two agree on
        // what a region is.
        if (/\slän$/i.test(name) && tax.region?.has(key)) reg.push(name);
        else muni.push(name);   // unknown names become q in resolveFilters
      }
    }

    // Built as one expression so that every parameter pushed is one the
    // statement actually references. Binding more than there are
    // placeholders is a hard Postgres error, and it has already made
    // this exact button a 500 once.
    let expr = `coalesce(api_filters,'{}'::jsonb)`;
    if (muni.length) {
      vals.push(JSON.stringify(muni));
      expr = `jsonb_set(${expr}, '{municipality}', $${vals.length}::jsonb)`;
    } else {
      expr = `(${expr} - 'municipality')`;
    }
    if (reg.length) {
      vals.push(JSON.stringify(reg));
      expr = `jsonb_set(${expr}, '{region}', $${vals.length}::jsonb)`;
    } else {
      expr = `(${expr} - 'region')`;
    }
    sets.push(`api_filters = ${expr}`);
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
