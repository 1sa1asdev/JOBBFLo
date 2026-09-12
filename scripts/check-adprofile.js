// Shows what an ad looks like once read into the CV's vocabulary, and
// confirms which text the embedder would use for it.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { adEmbedText } from '../src/embed.js';
import { renderAdProfile, antalUtanProfil } from '../src/adprofile.js';

const kol = `title, employer, municipality, description, ad_profile,
  raw->'occupation'->>'label' AS occupation`;

const { rows: [med] } = await pool.query(
  `SELECT ${kol} FROM ads WHERE ad_profile IS NOT NULL LIMIT 1`);
const { rows: [utan] } = await pool.query(
  `SELECT ${kol} FROM ads WHERE ad_profile IS NULL AND removed_at IS NULL LIMIT 1`);

if (med) {
  const text = adEmbedText(med);
  console.log(`MED PROFIL — ${med.title}`);
  console.log(`  embeddas från profilen: ${text.startsWith('## ROLL')}`);
  console.log(`  ${text.split('\n').filter((r) => r.startsWith('## ')).join('  ')}`);
}
if (utan) {
  const text = adEmbedText(utan);
  console.log(`\nUTAN PROFIL — ${utan.title}`);
  console.log(`  faller tillbaka på råtext: ${!text.startsWith('## ')}`);
}

console.log(`\nannonser utan profil: ${(await antalUtanProfil()).toLocaleString('sv-SE')}`);
const { rows: [k] } = await pool.query(
  `SELECT count(*)::int AS n FROM ads WHERE ad_profile IS NOT NULL`);
console.log(`annonser med profil:  ${k.n.toLocaleString('sv-SE')}`);

await pool.end();
