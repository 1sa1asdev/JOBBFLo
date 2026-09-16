// Which vector actually predicts whether the CV meets the ad?
//
// The checklist is the closest thing to a ground truth this app has:
// it reads the ad's stated requirements and answers each one against
// the CV, with quotes on both sides. So the question for an embedding
// is how well it orders ads the same way that checklist does — and
// that question has two halves that are easy to confuse:
//
//   THE MODEL         text-embedding-3-small against the alternatives
//   WHAT IS COMPARED  ad text vs criteria (today), ad text vs CV, or
//                     the structured ad profile vs the structured CV
//                     profile — the same shape on both sides, which is
//                     what adprofile.js was built for
//
// A better model cannot fix comparing the wrong two things, so both are
// measured at once. Nothing is written: this embeds a sample and
// prints rank correlations.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { renderCvProfile } from '../src/cvprofile.js';
import { renderAdProfile } from '../src/adprofile.js';

const KEY = process.env.OPENROUTER_API_KEY.trim();
const MODELLER = [
  ['3-small (nu)', 'openai/text-embedding-3-small', 0.02],
  ['3-large', 'openai/text-embedding-3-large', 0.13],
  ['gemini-embedding-001', 'google/gemini-embedding-001', 0.15],
  ['bge-m3', 'baai/bge-m3', 0.02],
  ['qwen3-embedding-8b', 'qwen/qwen3-embedding-8b', 0.01],
];

async function embed(model, texts) {
  const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model, input: texts }),
  });
  const j = await r.json();
  if (j.error) throw new Error(String(j.error.message).slice(0, 100));
  return j.data.map((d) => d.embedding);
}

const cos = (a, b) => {
  let p = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { p += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return p / Math.sqrt(na * nb);
};

function spearman(a, b) {
  const rank = (xs) => {
    const s = xs.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = [];
    for (let i = 0; i < s.length;) {
      let j = i;
      while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j += 1;
      const m = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[s[k][1]] = m;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a); const rb = rank(b);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra); const mb = mean(rb);
  let t = 0; let sa = 0; let sb = 0;
  for (let i = 0; i < a.length; i++) {
    t += (ra[i] - ma) * (rb[i] - mb); sa += (ra[i] - ma) ** 2; sb += (rb[i] - mb) ** 2;
  }
  return t / Math.sqrt(sa * sb);
}

const { rows: [p] } = await pool.query(`SELECT cv_text, cv_profile FROM profile LIMIT 1`);
const cvProfil = renderCvProfile(p.cv_profile) || p.cv_text || '';

const { rows } = await pool.query(
  `SELECT a.title, a.description, a.ad_profile, c.score,
          (SELECT s.criteria_text FROM match_results m JOIN searches s ON s.id = m.search_id
           WHERE m.ad_id = a.id LIMIT 1) AS kriterier
   FROM ad_checks c JOIN ads a ON a.id = c.ad_id
   WHERE c.score IS NOT NULL AND a.ad_profile IS NOT NULL`);
if (rows.length < 8) { console.log(`bara ${rows.length} annonser med kravpoäng — för få`); process.exit(0); }

const kriterier = rows[0].kriterier || '';
const poäng = rows.map((r) => r.score);
const annonstext = rows.map((r) => `${r.title}\n${(r.description || '').slice(0, 4000)}`);
const annonsprofil = rows.map((r) => renderAdProfile(r.ad_profile) || r.title);

console.log(`${rows.length} annonser med kravpoäng ${Math.min(...poäng)}–${Math.max(...poäng)}\n`);
console.log('modell'.padEnd(22) + 'annons↔kriterier'.padEnd(19)
  + 'annons↔CV'.padEnd(13) + 'profil↔CV-profil'.padEnd(19) + 'pool om vi byter');

for (const [namn, model, prisPerM] of MODELLER) {
  try {
    const [vKriterier, vCv] = await embed(model, [kriterier, cvProfil]);
    const vAnnons = await embed(model, annonstext);
    const vProfil = await embed(model, annonsprofil);

    const mot = (vektorer, fråga) => spearman(poäng, vektorer.map((v) => cos(v, fråga)));
    // 43k ads, about 1000 tokens each, plus the profiles
    const poolKostnad = (43000 * 1000 * prisPerM) / 1e6;

    console.log(namn.padEnd(22)
      + mot(vAnnons, vKriterier).toFixed(2).padEnd(19)
      + mot(vAnnons, vCv).toFixed(2).padEnd(13)
      + mot(vProfil, vCv).toFixed(2).padEnd(19)
      + `$${poolKostnad.toFixed(2)}`);
  } catch (err) {
    console.log(namn.padEnd(22) + `fel: ${err.message.slice(0, 60)}`);
  }
}

console.log('\n(1.00 = samma ordning som kravchecklistan, 0 = ingen koppling)');
await pool.end();
