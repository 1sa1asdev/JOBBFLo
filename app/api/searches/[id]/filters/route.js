import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';
import { suggestFilters } from '../../../../../src/filterSuggest.js';
import { scanSearch } from '../../../../../src/score.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// The two states of a search's filters: what is on, and what could be.
export async function GET(_req, { params }) {
  const { id } = await params;
  try {
    return NextResponse.json(await suggestFilters(id));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ------------------------------------------------------------
// Switch one filter on or off.
//
//   { add: { key, value, ersätter: [keys] } }   turn a suggestion on
//   { remove: key }                              turn a filter off
//
// `ersätter` is how the occupation axes stay exclusive. The API ORs
// them — field + group returns the wider of the two — so taking a group
// suggestion has to take the field off, or the click changes nothing
// the user can see and they conclude the suggestion was wrong.
//
// What a change does to the candidate pool is the same thing a chat
// edit to the criteria does, and deliberately so: untouched candidates
// found under the old filters go, favourites and paid verdicts stay,
// and the sweep starts again from the front. Two ways of changing the
// filters with two different effects would be a second kind of bug.
// ------------------------------------------------------------
const TILLÅTNA = new Set(['occupation-field', 'occupation-group', 'occupation-name',
  'municipality', 'region', 'employment-type', 'worktime-extent',
  'experience', 'trainee', 'larling', 'remote', 'q']);

export async function PATCH(req, { params }) {
  const { id } = await params;
  const { add, remove } = await req.json();

  const { rows: [s] } = await pool.query(
    `SELECT api_filters FROM searches WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!s) return NextResponse.json({ error: 'sökningen finns inte' }, { status: 404 });

  const filter = { ...(s.api_filters || {}) };
  if (add) {
    if (!TILLÅTNA.has(add.key)) {
      return NextResponse.json({ error: `okänt filter: ${add.key}` }, { status: 400 });
    }
    for (const k of add.ersätter || []) delete filter[k];
    filter[add.key] = add.value;
  } else if (remove) {
    if (!(remove in filter)) {
      return NextResponse.json({ error: `filtret är inte på: ${remove}` }, { status: 400 });
    }
    delete filter[remove];
  } else {
    return NextResponse.json({ error: 'add eller remove krävs' }, { status: 400 });
  }

  // criteria_changed_at is NOT touched. A filter decides which ads are
  // fetched; it does not change the question existing verdicts
  // answered. Bumping it would mark every score in the search stale —
  // "ÄLDRE KRITERIER" on all of them, an offer to pay for re-scoring,
  // and verdict reuse switched off for the lot.
  // `location` is what the Ort picker above the chat shows. It is kept
  // equal to the place filters, or switching Ort off here would leave
  // the picker still saying Stockholm — and its next save would quietly
  // put the filter back.
  const orter = [...[].concat(filter.municipality ?? []), ...[].concat(filter.region ?? [])];
  await pool.query(
    `UPDATE searches SET api_filters = $2::jsonb, location = $3::text[],
       fetch_offset = 0, fetch_total = NULL, fetch_done_at = NULL, dropped_filters = NULL
     WHERE id = $1`,
    [id, JSON.stringify(filter), orter.length ? orter : null]
  );
  const { rowCount: rensade } = await pool.query(
    `DELETE FROM match_results
     WHERE search_id = $1 AND shortlisted_at IS NULL AND score IS NULL`, [id]);

  // Not awaited: the answer to the click is the new state, and the
  // sweep fills the list in behind it the way a criteria edit does.
  scanSearch(id, { pages: 2 }).catch((e) => console.error(`filterbyte ${id}:`, e.message));

  return NextResponse.json({ api_filters: filter, rensade });
}
