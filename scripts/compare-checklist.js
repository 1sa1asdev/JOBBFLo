// The checklist against the verdicts it replaces, on the same ads.
//
// Answers four questions with numbers rather than opinion:
//
//   ORDER      does it rank ads the way the old scorer did (Spearman
//              over the overlap)? A different number is fine; a
//              different ORDER means the campaign would write to other
//              employers.
//   EVIDENCE   how many requirement rows carry a verbatim quote from
//              the ad, and how many answered rows carry one from the CV
//   SPREAD     a scorer that gives everything the same number cannot
//              rank anything
//   COST       per ad, against the ~$0.003 the old verdict cost
//
// Writes nothing to match_results: the ad_checks rows it creates are
// the cache every later run reuses, and the old verdicts stay as they
// are so the comparison can be repeated.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { checkAd } from '../src/checklist.js';
import { renderCvProfile } from '../src/cvprofile.js';
import { adTextShownToModel } from '../src/score.js';

const ANTAL = Number(process.argv[2] || 30);

const spend = async () => {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return null;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } });
    return (await r.json())?.data?.usage ?? null;
  } catch { return null; }
};

// Spearman: rank correlation, so it measures ORDER and ignores the fact
// that two scales can differ by a constant.
function spearman(a, b) {
  const rang = (xs) => {
    const sorterad = [...xs].map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(xs.length);
    for (let i = 0; i < sorterad.length;) {
      let j = i;
      while (j + 1 < sorterad.length && sorterad[j + 1][0] === sorterad[i][0]) j += 1;
      const medel = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[sorterad[k][1]] = medel;
      i = j + 1;
    }
    return r;
  };
  const ra = rang(a);
  const rb = rang(b);
  const n = a.length;
  const m = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = m(ra);
  const mb = m(rb);
  let täljare = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    täljare += (ra[i] - ma) * (rb[i] - mb);
    sa += (ra[i] - ma) ** 2;
    sb += (rb[i] - mb) ** 2;
  }
  return täljare / Math.sqrt(sa * sb);
}

const { rows: [p] } = await pool.query(`SELECT cv_text, cv_profile FROM profile LIMIT 1`);
const cvRenderad = renderCvProfile(p.cv_profile) || p.cv_text || '';

// Ads with a verdict from the old scorer, still open, spread across the
// score range rather than the top of one search.
const { rows: ads } = await pool.query(
  `SELECT a.*, m.score AS gammal, m.summary AS gammal_text, m.search_id, s.must_criteria
   FROM match_results m
   JOIN ads a ON a.id = m.ad_id
   JOIN searches s ON s.id = m.search_id
   WHERE m.score IS NOT NULL AND m.score_reused_from IS NULL
     AND a.removed_at IS NULL AND (a.deadline IS NULL OR a.deadline >= current_date)
     AND length(a.description) > 400
   ORDER BY m.ad_id, m.scored_at DESC`,
);
const unika = [...new Map(ads.map((a) => [a.id, a])).values()];
// Even coverage of the old scale, so the comparison is not all 30s.
unika.sort((x, y) => x.gammal - y.gammal);
const steg = Math.max(1, Math.floor(unika.length / ANTAL));
const urval = unika.filter((_, i) => i % steg === 0).slice(0, ANTAL);

console.log(`${urval.length} annonser, gamla poäng ${urval[0]?.gammal}–${urval[urval.length - 1]?.gammal}\n`);

const före = await spend();
const t0 = Date.now();
const rader = [];

for (const ad of urval) {
  try {
    const r = await checkAd(ad, { cvText: p.cv_text, cvProfile: p.cv_profile, force: true });
    const annonstext = adTextShownToModel(ad);
    const medBelagg = (r.items || []).filter((i) => i.evidence).length;
    const svarade = (r.items || []).filter((i) => i.status === 'uppfyllt' || i.status === 'delvis');
    const medCv = svarade.filter((i) => i.cv_belagg).length;
    const ordagranna = (r.items || []).filter((i) => i.evidence
      && annonstext.replace(/\s+/g, ' ').toLowerCase().includes(i.evidence.replace(/\s+/g, ' ').toLowerCase())).length;
    rader.push({
      titel: ad.title.slice(0, 38), gammal: ad.gammal, ny: r.score,
      krav: (r.items || []).length, medBelagg, ordagranna, svarade: svarade.length, medCv,
      sammanfattning: r.summary,
    });
    console.log(`${String(ad.gammal).padStart(3)} → ${String(r.score ?? '—').padStart(3)}  ${ad.title.slice(0, 40).padEnd(42)} ${r.summary}`);
  } catch (err) {
    console.error(`  !! ${ad.title.slice(0, 40)}: ${err.message.slice(0, 120)}`);
  }
}

const efter = await spend();
const med = rader.filter((r) => r.ny != null);
const gamla = med.map((r) => r.gammal);
const nya = med.map((r) => r.ny);
const medel = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const spridning = (xs) => Math.sqrt(medel(xs.map((x) => (x - medel(xs)) ** 2)));
const summa = (f) => rader.reduce((s, r) => s + f(r), 0);

console.log(`\nRANGORDNING  spearman ${spearman(gamla, nya).toFixed(2)} (1 = samma ordning)`);
console.log(`SPRIDNING    gammal medel ${medel(gamla).toFixed(0)} sd ${spridning(gamla).toFixed(0)}`
  + `  |  ny medel ${medel(nya).toFixed(0)} sd ${spridning(nya).toFixed(0)}`);
console.log(`KRAV         ${summa((r) => r.krav)} rader, ${summa((r) => r.medBelagg)} med citat ur annonsen, `
  + `${summa((r) => r.ordagranna)} av dem ordagranna`);
console.log(`CV-BELÄGG    ${summa((r) => r.medCv)} av ${summa((r) => r.svarade)} besvarade rader har ordagrant CV-citat`);
if (före != null && efter != null) {
  console.log(`KOSTNAD      $${(efter - före).toFixed(3)} totalt, `
    + `$${((efter - före) / Math.max(1, med.length)).toFixed(4)} per annons `
    + `(gamla bedömningen: ~$0.0030)`);
}
console.log(`TID          ${Math.round((Date.now() - t0) / 1000)}s, ${(med.length / Math.max(1, (Date.now() - t0) / 1000)).toFixed(2)} annonser/s`);

// The disagreements are the interesting part: same ad, two answers.
const oense = [...med].sort((a, b) => Math.abs(b.ny - b.gammal) - Math.abs(a.ny - a.gammal)).slice(0, 5);
console.log('\nSTÖRSTA SKILLNADERNA');
for (const r of oense) console.log(`  ${r.gammal} → ${r.ny}  ${r.titel.padEnd(40)} ${r.sammanfattning}`);

await pool.end();
