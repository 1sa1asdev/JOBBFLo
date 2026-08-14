// ------------------------------------------------------------
// End-to-end proof, no UI. (CLAUDE.md build order, step 1.)
//
//   npm run db:init && npm run db:seed && npm run try
//
// Creates a search from natural-language criteria, backfills ads
// from JobSearch, scores 15, prints them. READ the output — if
// the scores are wrong, iterate on the prompt in src/score.js.
// Everything else is a wrapper around this call.
// ------------------------------------------------------------
import 'dotenv/config';
import { pool } from '../src/db.js';
import { llmAvailable } from '../src/llm.js';
import { parseCriteria, scanSearch } from '../src/score.js';

const CRITERIA =
  process.argv.slice(2).join(' ') ||
  'Junior/mid frontend- eller fullstackroller i Stockholm. Inget krav på 5+ års erfarenhet, gärna React. Inte intresserad av tunga .NET-legacy-grejer. Hybrid är okej.';

if (!(await llmAvailable())) {
  console.error('Ingen AI-leverantör konfigurerad — välj en i appen (Profil → AI-leverantör) eller sätt OPENROUTER_API_KEY / ANTHROPIC_API_KEY i .env.');
  process.exit(1);
}

const { rows: [profile] } = await pool.query(`SELECT id FROM profile LIMIT 1`);
if (!profile) {
  console.error('Ingen profil — kör npm run db:seed först (och lägg in ditt riktiga CV i db/seed.sql).');
  process.exit(1);
}

console.log(`criteria: "${CRITERIA}"\n`);

// layer 1: natural language -> API filters
const { filters, unmapped } = await parseCriteria(CRITERIA);
console.log('layer 1 filters:', JSON.stringify(filters));
if (unmapped?.length) console.log('handled in layer 2:', unmapped.join(' · '));

// reuse the tryit search if it exists so reruns don't pile up
let { rows: [search] } = await pool.query(
  `SELECT * FROM searches WHERE name = 'tryit' AND deleted_at IS NULL`
);
if (search) {
  await pool.query(
    `UPDATE searches SET criteria_text = $2, api_filters = $3 WHERE id = $1`,
    [search.id, CRITERIA, JSON.stringify(filters)]
  );
} else {
  ({ rows: [search] } = await pool.query(
    `INSERT INTO searches (profile_id, name, criteria_text, api_filters)
     VALUES ($1, 'tryit', $2, $3) RETURNING *`,
    [profile.id, CRITERIA, JSON.stringify(filters)]
  ));
}

// layer 1 backfill from JobSearch, then layer 2 scoring of exactly
// those ads (JobStream only streams changes going forward)
console.log('');
const { results } = await scanSearch(search.id, { limit: 15, fetchLimit: 50 });

console.log(`\n${'—'.repeat(60)}`);
for (const r of results.sort((a, b) => b.score - a.score)) {
  console.log(`\n${String(r.score).padStart(3)}  ${r.ad.title} — ${r.ad.employer}`);
  console.log(`     ${r.summary}`);
  for (const f of r.flags || []) console.log(`     ⚑ [${f.tag}] "${f.quote}"`);
}
console.log(`\n${results.length} annonser bedömda. Läs dem — stämmer poängen?`);

await pool.end();
