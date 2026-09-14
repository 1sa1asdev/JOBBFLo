import { pool } from './db.js';
import { embedTexts } from './embed.js';
import { loadTaxonomy } from './taxonomy.js';

// ------------------------------------------------------------
// The occupation taxonomy, embedded, for suggesting filters.
//
// Asking a model for an occupation-group label means it has to
// reproduce Arbetsförmedlingen's exact wording, and it mostly cannot:
// "frontendutvecklare" resolved to nothing, and a paraphrased group
// name falls through to free-text q where the words get AND-ed. The
// embedder does not have to spell anything. It places the user's
// words near the real labels, and whatever comes back is a concept id
// that exists by construction.
//
// Embedded once — 400 groups and ~2100 occupation names are short
// strings, a fraction of a cent — and looked up with one indexed query.
// ------------------------------------------------------------
const AXLAR = ['occupation-group', 'occupation-name'];

export async function buildTaxonomyVectors({ force = false } = {}) {
  const { rows: [finns] } = await pool.query(
    `SELECT count(*)::int AS n FROM taxonomy_vectors`);
  if (finns.n && !force) return { hoppade: true, antal: finns.n };

  const tax = await loadTaxonomy();
  let antal = 0;
  for (const typ of AXLAR) {
    const karta = tax[typ];
    if (!karta?.labels?.length) {
      throw new Error(`taxonomin gav inga begrepp för ${typ}`);
    }
    // Original casing for display; the map itself is keyed lowercase.
    const etiketter = [...new Set(karta.labels)];
    for (let i = 0; i < etiketter.length; i += 200) {
      const del = etiketter.slice(i, i + 200);
      const vektorer = await embedTexts(del);
      for (const [j, label] of del.entries()) {
        const id = karta.get(label.toLowerCase());
        if (!id) continue;
        await pool.query(
          `INSERT INTO taxonomy_vectors (type, concept_id, label, embedding)
           VALUES ($1, $2, $3, $4::vector)
           ON CONFLICT (type, concept_id) DO UPDATE
             SET label = EXCLUDED.label, embedding = EXCLUDED.embedding`,
          [typ, id, label, `[${vektorer[j].join(',')}]`]
        );
        antal += 1;
      }
    }
  }
  return { hoppade: false, antal };
}

// Nearest occupations to some text, per axis. `avstand` is cosine
// distance — lower is closer — and is returned so a caller can refuse
// a weak match instead of suggesting the least-bad group in Sweden.
export async function nearestOccupations(text, { k = 3, vektor = null } = {}) {
  const v = vektor || (await embedTexts([text]))[0];
  const lit = `[${v.join(',')}]`;
  const ut = {};
  for (const typ of AXLAR) {
    const { rows } = await pool.query(
      `SELECT concept_id, label, (embedding <=> $2::vector) AS avstand
       FROM taxonomy_vectors WHERE type = $1
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [typ, lit, k]
    );
    ut[typ] = rows.map((r) => ({ ...r, avstand: Number(r.avstand) }));
  }
  return ut;
}
