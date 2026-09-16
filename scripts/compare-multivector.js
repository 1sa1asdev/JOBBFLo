// One vector per side, or one vector per fact?
//
// A single vector for a CV is an average: frontend React, Node, two
// years of restaurant work, Swedish, a degree in progress — all folded
// into one point. Nothing in the CV is actually at that point, which is
// why a single vector answers "is this the same sort of job" and not
// "can this person do it".
//
// Multi-vector keeps the facts apart. Each requirement in the ad gets
// its own vector, each fact in the CV gets its own, and the score is
// built from how well each REQUIREMENT is covered by SOMETHING in the
// CV — the same question the checklist asks, but arithmetic instead of
// a model.
//
// Measured against the checklist's own scores, the way the single-vector
// variants were.
import 'dotenv/config';
import { pool } from '../src/db.js';

const KEY = process.env.OPENROUTER_API_KEY.trim();
const MODEL = process.env.EMBED_MODEL || 'openai/text-embedding-3-small';

async function embed(texts) {
  const ut = [];
  for (let i = 0; i < texts.length; i += 96) {
    const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model: MODEL, input: texts.slice(i, i + 96) }),
    });
    const j = await r.json();
    if (j.error) throw new Error(String(j.error.message).slice(0, 120));
    ut.push(...j.data.map((d) => d.embedding));
  }
  return ut;
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

// ---- the CV, as separate facts ----
const { rows: [p] } = await pool.query(`SELECT cv_text, cv_profile FROM profile LIMIT 1`);
const cvp = p.cv_profile || {};
const cvFakta = [
  ...(cvp.skills || []).map((s) => `${s.name}${s.field ? ` (${s.field})` : ''}`),
  ...(cvp.experience || []).flatMap((e) => [
    `${e.role || ''} ${e.what || ''}`.trim(),
    ...(e.skills || []),
  ]),
  ...(cvp.education || []).map((e) => e.what || e.name || ''),
  ...(cvp.languages || []).map((l) => `${l.name} ${l.level || ''}`.trim()),
  ...(cvp.domains || []).map((d) => d.name || ''),
].map((t) => String(t).trim()).filter((t) => t.length > 2);

if (cvFakta.length < 5) { console.log('för få fakta i CV-profilen'); process.exit(0); }

const { rows } = await pool.query(
  `SELECT a.title, a.ad_profile, c.score FROM ad_checks c JOIN ads a ON a.id = c.ad_id
   WHERE c.score IS NOT NULL AND a.ad_profile IS NOT NULL
     AND jsonb_array_length(a.ad_profile->'requires') > 1`);
if (rows.length < 8) { console.log(`bara ${rows.length} annonser — för få`); process.exit(0); }

console.log(`${rows.length} annonser, ${cvFakta.length} fakta ur CV:t\n`);

const vCv = await embed(cvFakta);

const poäng = [];
const enVektor = [];
const maxTäckning = [];
const hårdTäckning = [];
const svagasteKravet = [];

for (const r of rows) {
  const krav = (r.ad_profile.requires || []).map((k) => ({
    text: `${k.name}${k.field ? ` (${k.field})` : ''}`,
    hård: k.weight !== 'meriterande',
  }));
  if (!krav.length) continue;
  const vKrav = await embed(krav.map((k) => k.text));

  // Every requirement against every CV fact: how well is this demand
  // covered by anything the candidate has?
  const täckning = vKrav.map((v) => Math.max(...vCv.map((c) => cos(v, c))));

  poäng.push(r.score);
  // One vector per side: the ad's requirements averaged, against the
  // CV averaged. This is what a single-vector search does.
  const medel = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const snittKrav = vKrav[0].map((_, i) => medel(vKrav.map((v) => v[i])));
  const snittCv = vCv[0].map((_, i) => medel(vCv.map((v) => v[i])));
  enVektor.push(cos(snittKrav, snittCv));

  maxTäckning.push(medel(täckning));
  const hårda = täckning.filter((_, i) => krav[i].hård);
  hårdTäckning.push(hårda.length ? medel(hårda) : medel(täckning));
  // The weakest link: a requirement nothing in the CV comes near is
  // what the checklist calls "saknas".
  svagasteKravet.push(hårda.length ? Math.min(...hårda) : Math.min(...täckning));
}

console.log('metod'.padEnd(40) + 'rangkorrelation med kravpoängen');
console.log('en vektor per sida (som i dag)'.padEnd(40) + spearman(poäng, enVektor).toFixed(2));
console.log('multivektor: snitt av bästa träff'.padEnd(40) + spearman(poäng, maxTäckning).toFixed(2));
console.log('multivektor: bara hårda krav'.padEnd(40) + spearman(poäng, hårdTäckning).toFixed(2));
console.log('multivektor: svagaste kravet'.padEnd(40) + spearman(poäng, svagasteKravet).toFixed(2));
console.log('\n(1.00 = samma ordning som kravchecklistan)');
await pool.end();
