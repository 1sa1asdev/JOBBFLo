import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// Where the user travels from, resolved WITHOUT a geocoding service.
//
// Arbetsförmedlingen already ships lon/lat on every ad, so the ad pool
// itself is a postcode gazetteer — 2305 distinct Swedish postcodes and
// growing. Looking a postcode up there costs one query and sends
// nothing to a third party, which matters because a home address is
// the most personal thing this app stores.
//
// Falls back to matching a place name against the same data, so
// "Södermalm" or a municipality works when a postcode isn't to hand.
// ------------------------------------------------------------
export async function POST(req) {
  const { home } = await req.json();
  const raw = String(home || '').trim();

  if (!raw) {
    await pool.query(
      `UPDATE profile SET home_lat = NULL, home_lon = NULL, home_label = NULL`);
    return NextResponse.json({ cleared: true });
  }

  const digits = raw.replace(/\s+/g, '');
  let found = null;

  // A Swedish postcode is five digits — the precise case, so try it first.
  if (/^\d{5}$/.test(digits)) {
    const { rows } = await pool.query(
      `SELECT lat, lon, ads FROM postcode_coords WHERE postcode = $1`, [digits]);
    if (rows[0]) found = { ...rows[0], how: 'postnummer' };
  }

  // Otherwise match a place: city, municipality, or street. Averaging
  // the matching ads gives a centroid, which is accurate enough for a
  // commute filter and needs no external service.
  if (!found) {
    const { rows } = await pool.query(
      `SELECT avg(lat) AS lat, avg(lon) AS lon, count(*) AS ads
       FROM ads
       WHERE lat IS NOT NULL
         AND (raw->'workplace_address'->>'city' ILIKE $1
           OR raw->'workplace_address'->>'municipality' ILIKE $1
           OR raw->'workplace_address'->>'street_address' ILIKE $1)`,
      [raw]
    );
    if (rows[0]?.lat != null) found = { ...rows[0], how: 'ortsnamn' };
  }

  if (!found) {
    return NextResponse.json(
      { error: `Hittade inte "${raw}". Prova ett postnummer (fem siffror) eller ett ortsnamn.` },
      { status: 404 }
    );
  }

  await pool.query(
    `UPDATE profile SET home_lat = $1, home_lon = $2, home_label = $3`,
    [found.lat, found.lon, raw]
  );
  return NextResponse.json({
    home: raw, lat: found.lat, lon: found.lon,
    how: found.how, basedOn: Number(found.ads),
  });
}
