import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { parseCriteria, scanSearch } from '../../../../src/score.js';

export const dynamic = 'force-dynamic';

// ------------------------------------------------------------
// Create a campaign.
//
// A campaign is a search that also auto-applies: it needs criteria,
// API filters and scored ads exactly like one, so it IS one rather
// than a parallel concept with duplicate machinery. It just starts
// with auto-apply settings attached — and switched OFF, with no
// letter, so nothing can go out until both are deliberately set up.
// ------------------------------------------------------------
export async function POST(req) {
  const {
    name, criteria, min_score, daily_limit,
    locations, location_ratio, worktime, must_criteria, require_score,
  } = await req.json();
  if (!criteria?.trim()) {
    return NextResponse.json({ error: 'beskriv vilka annonser kampanjen gäller' }, { status: 400 });
  }

  const { rows: [profile] } = await pool.query(`SELECT id FROM profile LIMIT 1`);
  if (!profile) return NextResponse.json({ error: 'ingen profil' }, { status: 400 });

  let filters = {};
  let parseError = null;
  try {
    ({ filters } = await parseCriteria(criteria));
  } catch (err) {
    parseError = err.message;
    filters = { q: criteria.slice(0, 200) };   // still search, just less precisely
  }

  // An explicit pick BEATS the parse. The model reads the same prose to
  // guess a place, and when the user has already said which places they
  // mean, a guess can only disagree. This is the same rule the search
  // PATCH follows, and it is why the picker exists at all.
  const picked = [...new Set(
    [].concat(locations ?? []).map((s) => String(s).trim()).filter(Boolean)
  )];
  if (picked.length) {
    const { loadTaxonomy } = await import('../../../../src/taxonomy.js');
    const tax = await loadTaxonomy();
    const muni = [];
    const reg = [];
    for (const p of picked) {
      // " län" is the test, not membership: the region list is
      // EURES-wide and holds bare city names, so "Stockholm" is in
      // both maps and would be read as a county.
      if (/\slän$/i.test(p) && tax.region?.has(p.toLowerCase())) reg.push(p);
      else muni.push(p);
    }
    delete filters.municipality;
    delete filters.region;
    if (muni.length) filters.municipality = muni;
    if (reg.length) filters.region = reg;
  }

  if (worktime === 'Heltid' || worktime === 'Deltid') {
    filters['worktime-extent'] = worktime;
  } else if (worktime === null) {
    delete filters['worktime-extent'];
  }

  const { rows: [search] } = await pool.query(
    // apply_filter = 'email' is not a default the user can be asked
    // about here — it is the only setting that makes sense. A campaign
    // sends by mail or not at all (src/autoapply.js requires
    // apply_email in three places), so scoring link-only ads would buy
    // verdicts on candidates it structurally cannot contact. That is
    // ~79% of the pool, and it is why campaigns skip the chat question.
    `INSERT INTO searches (profile_id, name, criteria_text, api_filters,
       auto_apply_enabled, auto_apply_min_score, auto_apply_daily_limit,
       apply_filter, campaign_created_at,
       location, location_ratio, must_criteria, auto_apply_require_score)
     VALUES ($1,$2,$3,$4,false,$5,$6,'email',now(),
       $7::text[], $8::jsonb, $9, $10) RETURNING *`,
    [profile.id, name?.trim() || criteria.slice(0, 60), criteria, JSON.stringify(filters),
     Math.max(0, Math.min(100, Number(min_score) || 85)),
     Math.max(1, Math.min(100, Number(daily_limit) || 3)),
     picked.length ? picked : null,
     // A ratio only means something across several places, so one place
     // silently drops it rather than storing a split of one.
     picked.length > 1 && location_ratio && Object.keys(location_ratio).length
       ? JSON.stringify(location_ratio) : null,
     String(must_criteria || '').trim() ? String(must_criteria).trim().slice(0, 600) : null,
     require_score === undefined ? true : Boolean(require_score)]
  );

  await pool.query(
    `INSERT INTO search_messages (search_id, role, content) VALUES ($1,'user',$2)`,
    [search.id, criteria]
  );
  await pool.query(
    `INSERT INTO search_messages (search_id, role, content) VALUES ($1,'assistant',$2)`,
    [search.id, parseError
      ? `Kampanjen är skapad, men kriterierna kunde inte tolkas mot API:t (${parseError}) — söker med fritext.`
      : `Kampanj skapad. Filter: ${Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(' · ') || 'breda'}. Nästa steg: skriv kampanjbrevet.`]
  );

  // fill the queue in the background so the letter step has real ads
  // to preview against
  (async () => {
    try { await scanSearch(search.id, { pages: 2 }); }
    catch (err) { console.error(`campaign scan ${search.id}:`, err.message); }
  })();

  return NextResponse.json(search, { status: 201 });
}
