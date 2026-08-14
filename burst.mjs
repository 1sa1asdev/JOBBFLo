import 'dotenv/config';
import { pool } from './src/db.js';
import { scoreAd } from './src/score.js';
const { rows:[p] } = await pool.query(`SELECT cv_text, about_text FROM profile LIMIT 1`);
const { rows: projects } = await pool.query(`SELECT name, summary, tech FROM projects`);
const { rows: ads } = await pool.query(
  `SELECT * FROM ads WHERE removed_at IS NULL AND length(description)>2500 ORDER BY random() LIMIT 12`);
const t0 = Date.now(); let ok=0, fail=0;
for (const [i, ad] of ads.entries()) {
  try {
    const r = await scoreAd({ ad, profile:p, projects, criteriaText:'Junior frontend i Stockholm, React.' });
    ok++; process.stdout.write(`  ${i+1}. ${String(r.score).padStart(3)} ${ad.title.slice(0,44)}\n`);
  } catch(e){ fail++; process.stdout.write(`  ${i+1}. FEL: ${e.message.slice(0,90)}\n`); }
}
console.log(`\n${ok} lyckades, ${fail} misslyckades på ${((Date.now()-t0)/1000).toFixed(0)}s`);
await pool.end();
