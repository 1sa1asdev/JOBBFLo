// Proves verdict reuse on a controlled pair, then removes every row it
// made.
//
// Two twins of one already-scored ad, both queued for scoring:
//   identical  same text      → must copy the verdict, no model call
//   edited     a quote removed → must NOT copy, and goes to the model
//
// The OpenRouter key being over its limit makes this sharper, not
// weaker: a copy succeeds without the model, and a fresh score cannot.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { scorePending } from '../src/score.js';

const { rows: [kalla] } = await pool.query(
  `SELECT m.search_id, m.score, m.matched, m.flags, a.*
   FROM match_results m JOIN ads a ON a.id = m.ad_id
   JOIN searches s ON s.id = m.search_id
   WHERE m.score IS NOT NULL AND m.score_reused_from IS NULL
     AND jsonb_array_length(m.matched) > 0
     AND (s.criteria_changed_at IS NULL OR m.scored_at >= s.criteria_changed_at)
     AND a.removed_at IS NULL AND (a.deadline IS NULL OR a.deadline >= current_date)
   ORDER BY m.scored_at DESC LIMIT 1`);
if (!kalla) { console.log('ingen bedömd annons att prova med'); process.exit(0); }
console.log(`källa: ${kalla.title} — ${kalla.employer}, poäng ${kalla.score}`);

const skapade = [];
async function tvilling(etikett, description) {
  const { rows: [ad] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, employer_type,
       municipality, region, description, apply_email, apply_url, published_at, deadline, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12, '{}'::jsonb)
     RETURNING id`,
    [kalla.source, `prov-${etikett}-${Date.now()}`, kalla.fingerprint, kalla.title,
     kalla.employer, kalla.employer_type, kalla.municipality, kalla.region,
     description, kalla.apply_email, kalla.apply_url, kalla.deadline]);
  await pool.query(
    `INSERT INTO match_results (search_id, ad_id, queued_at, score_requested_at)
     VALUES ($1, $2, now(), now())`, [kalla.search_id, ad.id]);
  skapade.push(ad.id);
  return ad.id;
}

// The edited twin loses the first matched quote from its text entirely.
const citat = kalla.matched[0].quote;
const identisk = await tvilling('identisk', kalla.description);
const andrad = await tvilling('andrad', kalla.description.split(citat).join(' '));

try {
  const res = await scorePending(kalla.search_id, { limit: 10 });
  for (const [namn, id] of [['identisk', identisk], ['ändrad', andrad]]) {
    const { rows: [r] } = await pool.query(
      `SELECT score, score_reused_from, last_error FROM match_results
       WHERE search_id = $1 AND ad_id = $2`, [kalla.search_id, id]);
    console.log(`  ${namn.padEnd(9)} poäng ${String(r.score ?? '—').padStart(3)}`
      + `  kopierad: ${Boolean(r.score_reused_from)}`
      + `${r.last_error ? `  (modellen: ${r.last_error.slice(0, 50)})` : ''}`);
  }
  console.log(`  scorePending: ${res.length} bedömda, ${res.filter((x) => x.reused).length} återanvända`);
} finally {
  await pool.query(`DELETE FROM ads WHERE id = ANY($1)`, [skapade]);
  console.log(`städat: ${skapade.length} provannonser borttagna`);
  await pool.end();
}
