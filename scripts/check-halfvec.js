// Does the embedding model fit in half precision? Run before switching
// models.
//
//   node scripts/check-halfvec.js            # 200 ads from the pool
//   EMBED_MODEL=... node scripts/check-halfvec.js
//
// Every vector column is halfvec(768) since migration 061, because
// text-embedding-3-small sends numbers that already are half precision:
// storing them at full precision only stored padding. A model that
// sends full precision would be rounded on the way in — probably
// harmlessly, but "probably" is what this measures:
//
//   unchanged   how many vectors survive halfvec exactly
//   deviation   the largest cosine distance between a vector and its
//               rounded self (0 = identical)
//   ranking     for 10 ads used as queries, whether the 10 nearest of
//               the sample are the same ones in the same order
//
// Embeds the sample with the configured model and platform key: about
// a tenth of a cent with text-embedding-3-small. Writes nothing.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { embedConfig, embedTexts, adEmbedText } from '../src/embed.js';

const ANTAL = Number(process.env.ANTAL || 200);
const cfg = embedConfig();
console.log(`modell: ${cfg.provider}:${cfg.model}, ${ANTAL} annonser\n`);

const { rows: ads } = await pool.query(
  `SELECT a.id, a.title, a.employer, a.municipality, a.description,
          a.raw->'occupation'->>'label' AS occupation
   FROM ads a WHERE a.removed_at IS NULL AND a.description IS NOT NULL
   ORDER BY md5(a.id::text) LIMIT $1`, [ANTAL]);
const vektorer = [];
for (let i = 0; i < ads.length; i += 64) {
  vektorer.push(...await embedTexts(ads.slice(i, i + 64).map(adEmbedText)));
}

// Rounded by Postgres itself, the same cast the columns apply.
const text = (v) => `[${v.join(',')}]`;
const { rows: rundade } = await pool.query(
  `SELECT (v::halfvec(768))::vector::text = v::text AS oförändrad,
          v <=> (v::halfvec(768))::vector AS avvikelse,
          (v::halfvec(768))::vector::text AS halv
   FROM unnest($1::vector[]) AS v`, [vektorer.map(text)]);
const halva = rundade.map((r) => JSON.parse(r.halv));

const oförändrade = rundade.filter((r) => r.oförändrad).length;
const avvikelse = Math.max(...rundade.map((r) => Number(r.avvikelse)));

const cos = (a, b) => {
  let p = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { p += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return p / Math.sqrt(na * nb);
};
const närmast = (lista, q) => lista.map((v, i) => [i, cos(lista[q], v)])
  .filter(([i]) => i !== q).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([i]) => i).join();
let sammaRang = 0;
const frågor = Math.min(10, vektorer.length);
for (let q = 0; q < frågor; q += 1) if (närmast(vektorer, q) === närmast(halva, q)) sammaRang += 1;

console.log(`oförändrade  ${oförändrade}/${rundade.length}`);
console.log(`avvikelse    ${avvikelse.toExponential(2)} (största cosinusavstånd till sin rundade kopia)`);
console.log(`rangordning  ${sammaRang}/${frågor} frågor med samma 10 närmaste i samma ordning`);

const ok = avvikelse < 1e-4 && sammaRang === frågor;
console.log(ok
  ? '\nhalvprecision räcker för den här modellen'
  : '\nhalvprecision ändrar resultaten — jämför sökresultaten innan modellen byts, eller migrera kolumnerna tillbaka till vector(768)');
await pool.end();
process.exit(ok ? 0 : 1);
