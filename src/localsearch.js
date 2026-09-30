import { pool } from './db.js';
import { resolveFilters } from './taxonomy.js';

// ------------------------------------------------------------
// One source of ads: the pool this app already holds.
//
// A search used to be answered by paging JobSearch per search, while
// the JobStream feed filled a local pool nobody searched. Two flows of
// the same data, and the per-search one carried everything awkward
// about it: a cursor to walk, an offset ceiling of 2000, a page an
// hour, and a filter set the API had to understand.
//
// Measured before the switch: the campaign's filters matched 556 ads
// locally against 544 through the API, and the 100 newest ads in
// JobSearch were all already in the pool. So the pool can answer the
// question in one statement, for free, with no cursor and no ceiling —
// and ranking by embedding distance costs nothing extra because the
// vector is already on the row.
//
// What the API still owns is INGEST: the feed brings ads in, and only
// an ad that is in the pool can be found here.
// ------------------------------------------------------------

// Filters this app can answer locally, and where the answer lives.
//
// Matched on concept_id, never on the label. Measured: the feed labels
// an ad "Tillsvidareanställning (inkl. eventuell provanställning)"
// while the filter is called "Tillsvidareanställning", and the API
// counts "Vanlig anställning" as the same thing — matching labels
// found 588 permanent jobs in Göteborg where the API finds 2810.
//
// remote, trainee and larling are deliberately absent: JobStream does
// not carry them on the ad (0 of 37749 open ads have the field at
// all), so the pool cannot answer them. Offering a filter that
// silently matches nothing is worse than not offering it — those
// wishes belong in the criteria text, which scoring reads.
const KONCEPTVÄG = {
  municipality: "a.raw->'workplace_address'->>'municipality_concept_id'",
  region: "a.raw->'workplace_address'->>'region_concept_id'",
  'occupation-field': "a.raw->'occupation_field'->>'concept_id'",
  'occupation-group': "a.raw->'occupation_group'->>'concept_id'",
  'occupation-name': "a.raw->'occupation'->>'concept_id'",
  'employment-type': "a.raw->'employment_type'->>'concept_id'",
};

// The API treats these two concepts as one filter — asking for either
// returns the same 2810 ads in Göteborg — so the pool must too, or
// "Tillsvidareanställning" would hide three quarters of the permanent
// jobs it is meant to show.
const LIKVÄRDIGA = {
  kpPX_CNN_gDU: ['kpPX_CNN_gDU', 'PFZr_Syz_cUq'],
  PFZr_Syz_cUq: ['kpPX_CNN_gDU', 'PFZr_Syz_cUq'],
};

export const LOKALA_FILTER = new Set([
  ...Object.keys(KONCEPTVÄG), 'worktime-extent', 'experience', 'q',
]);

// Build the WHERE fragments for one filter set. The params array is
// appended to, so the caller owns the numbering — every query here
// also binds a search id, and sometimes a vector.
//
// Takes RESOLVED filters (concept ids), which is what the API path is
// handed too: one place decides what a name means.
export function filterSql(resolved = {}, params = []) {
  const villkor = [];
  const lista = (v) => [...new Set([].concat(v ?? [])
    .filter((x) => x != null && String(x).trim() !== '')
    .flatMap((x) => LIKVÄRDIGA[x] || [x]))];

  for (const [key, väg] of Object.entries(KONCEPTVÄG)) {
    const v = lista(resolved[key]);
    if (!v.length) continue;
    params.push(v);
    villkor.push(`${väg} = ANY($${params.length}::text[])`);
  }

  // Omfattning stays SOFT, the way the API path had to fake it: of
  // 37749 open ads, 4036 say nothing at all about Heltid or Deltid,
  // and among those are "Nattreceptionist för extraarbete" and
  // "Spelledare (kvällar och helger)" — the exact jobs a Deltid filter
  // is meant to find. Keep the wanted extent, keep the unsaid, drop
  // only an explicit contradiction. Locally this is free, so the API
  // path's size ceiling on the same trick is gone.
  const omf = lista(resolved['worktime-extent']);
  if (omf.length) {
    params.push(omf);
    villkor.push(`(a.raw->'working_hours_type'->>'concept_id' IS NULL`
      + ` OR a.raw->'working_hours_type'->>'concept_id' = ANY($${params.length}::text[]))`);
  }

  if (resolved.experience === true || resolved.experience === false) {
    params.push(String(resolved.experience));
    villkor.push(`a.raw->>'experience_required' = $${params.length}`);
  }

  // Free text over title and body. plainto_tsquery ANDs the words, the
  // way the API's q does, and the Swedish dictionary stems them — so
  // "kock" also finds "kockar". ILIKE did the same job in 2.8s per
  // count; the full-text index answers in milliseconds.
  const fritext = [].concat(resolved.q ?? []).join(' ').trim();
  if (fritext) {
    params.push(fritext.slice(0, 200));
    villkor.push(`a.fts @@ plainto_tsquery('swedish', $${params.length})`);
  }

  return { villkor, params };
}

// Open, applicable, not blacklisted — the rules the old scan used.
const ÖPPEN = `a.removed_at IS NULL
  AND (a.deadline IS NULL OR a.deadline >= current_date)
  AND NOT EXISTS (SELECT 1 FROM never_apply na WHERE na.fingerprint = a.fingerprint)`;

// Many counts, one round trip.
//
// The filter suggestions ask for a dozen counts at once — what each
// narrowing would leave — and asking for them one at a time cost
// 0.9-1.2s on every load of the search view, most of it waiting
// between queries rather than counting. As scalar subqueries in one
// statement the same answers come back in one trip.
export async function countLocalMany(filterSets = []) {
  if (!filterSets.length) return [];
  const params = [];
  const delar = [];
  for (const f of filterSets) {
    const { villkor } = filterSql(await resolveFilters(f || {}), params);
    delar.push(`(SELECT count(*)::int FROM ads a
       WHERE ${ÖPPEN}${villkor.length ? ` AND ${villkor.join(' AND ')}` : ''})`);
  }
  const { rows: [r] } = await pool.query(
    `SELECT ${delar.map((d, i) => `${d} AS c${i}`).join(', ')}`, params);
  return filterSets.map((_, i) => r[`c${i}`]);
}

export async function countLocal(filters = {}, { resolved = false } = {}) {
  const f = resolved ? filters : await resolveFilters(filters || {});
  const { villkor, params } = filterSql(f, []);
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM ads a
     WHERE ${ÖPPEN}${villkor.length ? ` AND ${villkor.join(' AND ')}` : ''}`, params);
  return r.n;
}

// What a search drops to get any hits at all, in the order the API
// path used: the wishes first, the place last, because a place is the
// one filter the user almost always typed themselves.
const BREDDNINGSSTEGE = [
  ['employment-type'],
  ['experience'],
  ['q'],
  ['occupation-name', 'occupation-group', 'occupation-field'],
  ['municipality', 'region'],
];

// ------------------------------------------------------------
// Match a search against the pool. One statement, no paging.
//
// Ranked by embedding distance when the search has a query vector
// (pgvector's <=> is cosine distance, so ASC is most similar first),
// by publication date otherwise — an unembedded pool still sorts
// sensibly, which matters because embedding depends on a key that can
// run out.
//
// The cap exists because a search with no filters matches the whole
// country: 37k candidate rows is not a list anyone reads, and its tail
// is the least similar ads in Sweden.
// ------------------------------------------------------------
export async function matchSearch(searchId, { limit = 1500 } = {}) {
  const { rows: [s] } = await pool.query(
    `SELECT id, api_filters, query_embedding FROM searches
     WHERE id = $1 AND deleted_at IS NULL`, [searchId]);
  if (!s) throw new Error(`no search ${searchId}`);

  let filter = await resolveFilters(s.api_filters || {});
  let träffar = await countLocal(filter, { resolved: true });
  const släppta = [];
  for (const steg of BREDDNINGSSTEGE) {
    if (träffar > 0) break;
    const finns = steg.filter((k) => filter[k] != null);
    if (!finns.length) continue;
    filter = { ...filter };
    for (const k of finns) delete filter[k];
    släppta.push(...finns);
    träffar = await countLocal(filter, { resolved: true });
  }

  const params = [searchId];
  if (s.query_embedding) params.push(s.query_embedding);
  const vektor = s.query_embedding ? '$2::vector' : null;
  const { villkor } = filterSql(filter, params);
  params.push(limit);

  const rang = vektor
    ? `(a.embedding IS NULL), a.embedding <=> ${vektor}, a.published_at DESC NULLS LAST`
    : 'a.published_at DESC NULLS LAST';
  const poäng = vektor
    ? `CASE WHEN a.embedding IS NULL THEN NULL ELSE 1 - (a.embedding <=> ${vektor}) END`
    : 'NULL::float';

  const { rowCount: nya } = await pool.query(
    `INSERT INTO match_results (search_id, ad_id, queue_rank)
     SELECT $1, a.id, ${poäng}
     FROM ads a
     WHERE ${ÖPPEN}${villkor.length ? ` AND ${villkor.join(' AND ')}` : ''}
       AND NOT EXISTS (SELECT 1 FROM match_results m
                       WHERE m.search_id = $1 AND m.ad_id = a.id)
     ORDER BY ${rang}
     LIMIT $${params.length}
     ON CONFLICT (search_id, ad_id) DO NOTHING`,
    params
  );

  // The cursor columns are kept so nothing that reads them breaks, but
  // they no longer mean "how far into the API's result set we walked":
  // there is no walk. fetch_total is what the filters match right now.
  await pool.query(
    `UPDATE searches SET last_scanned_at = now(), fetch_total = $2,
       fetch_offset = 0, fetch_done_at = now(), dropped_filters = $3
     WHERE id = $1`,
    [searchId, träffar, släppta.length ? släppta : null]
  );

  return { found: nya, total: träffar, dropped: släppta };
}
