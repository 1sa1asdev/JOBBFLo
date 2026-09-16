// Which model should answer the checklist?
//
// The extraction step was measured separately (adprofile.js carries the
// numbers). This is the other call: the ad's requirements are already
// read, and the model says whether the CV meets each one, quoting the
// CV for every answer it claims.
//
// Three things decide it, and all three are checkable without an
// opinion:
//
//   FIDELITY   how many of its "uppfyllt"/"delvis" answers carry a
//              quote that is really in the CV. An unsourced claim is
//              the failure mode that matters — it is a verdict the user
//              cannot check, and the app downgrades it anyway.
//   AGREEMENT  per requirement, against gemini-2.5-flash as the
//              reference: same status, or not. A model that answers
//              differently is not automatically wrong, but the
//              disagreements are where a campaign would write to
//              another employer.
//   COST       per ad, from OpenRouter's own usage figures.
//
// Nothing is written to the database: this reads ad_checks for the
// requirement lists and answers them again.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { SYSTEM, scoreFromItems } from '../src/checklist.js';
import { renderCvProfile } from '../src/cvprofile.js';

const KEY = process.env.OPENROUTER_API_KEY.trim();
const REFERENS = 'google/gemini-2.5-flash';
const MODELLER = [
  ['flash', REFERENS, {}],
  ['flash utan thinking', REFERENS, { reasoning: { enabled: false } }],
  ['flash-lite', 'google/gemini-2.5-flash-lite', {}],
  ['deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash', {}],
  ['qwen3.8-flash', 'qwen/qwen3.8-flash', {}],
  ['mistral-small-2603', 'mistralai/mistral-small-2603', {}],
];

const ANTAL = Number(process.argv[2] || 10);
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

const { rows: [p] } = await pool.query(`SELECT cv_text, cv_profile FROM profile LIMIT 1`);
const cv = (renderCvProfile(p.cv_profile) || p.cv_text || '').slice(0, 9000);
const cvFlat = flat(cv);

const { rows: prov } = await pool.query(
  `SELECT a.title, c.items FROM ad_checks c JOIN ads a ON a.id = c.ad_id
   WHERE jsonb_array_length(c.items) >= 4
   ORDER BY c.checked_at DESC LIMIT $1`, [ANTAL]);
if (!prov.length) { console.log('inga kravlistor att fråga om'); process.exit(0); }

async function fråga(model, extra, krav) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    // A model that thinks for two minutes has answered the question of
    // whether to use it. gpt-oss-120b took 58s an ad on the other step.
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      usage: { include: true },
      ...extra,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',
          content: `## KRAV\n${krav.map((k) => `${k.id}. [${k.weight}] ${k.name}`
            + `${k.evidence ? ` — annonsen: "${k.evidence}"` : ''}`).join('\n')}`
            + `\n\n## CV-PROFIL\n${cv}` },
      ],
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 120));
  const txt = d.choices?.[0]?.message?.content || '';
  let svar = null;
  try { svar = JSON.parse(txt.replace(/^```json\s*|```$/g, '').trim()); } catch { /* trasig JSON */ }
  return {
    svar,
    sekunder: (Date.now() - t0) / 1000,
    kostnad: d.usage?.cost ?? 0,
    tänk: d.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

const summa = new Map(MODELLER.map(([namn]) => [namn, {
  kostnad: 0, tid: 0, tänk: 0, rader: 0, påståenden: 0, belagda: 0,
  lika: 0, jämförda: 0, trasiga: 0, poäng: [],
}]));

for (const ad of prov) {
  const krav = ad.items.map((i, n) => ({ ...i, id: n }));
  const facit = new Map();
  const rad = [];
  for (const [namn, model, extra] of MODELLER) {
    const s = summa.get(namn);
    try {
      const r = await fråga(model, extra, krav);
      s.kostnad += r.kostnad; s.tid += r.sekunder; s.tänk += r.tänk;
      if (!r.svar?.items) { s.trasiga += 1; rad.push(`${namn}: trasigt svar`); continue; }

      const svarPerId = new Map(r.svar.items.map((i) => [Number(i.id), i]));
      const items = krav.map((k) => {
        const a = svarPerId.get(k.id) || {};
        const status = ['uppfyllt', 'delvis', 'saknas', 'okänt'].includes(a.status) ? a.status : 'okänt';
        const belagg = a.cv_belagg && cvFlat.includes(flat(a.cv_belagg)) ? a.cv_belagg : null;
        return { ...k, status: status === 'uppfyllt' && !belagg ? 'delvis' : status, cv_belagg: belagg };
      });

      for (const [n, i] of items.entries()) {
        s.rader += 1;
        const svarat = svarPerId.get(n) || {};
        if (['uppfyllt', 'delvis'].includes(svarat.status)) {
          s.påståenden += 1;
          if (i.cv_belagg) s.belagda += 1;
        }
        if (namn === 'flash') facit.set(n, i.status);
        else if (facit.has(n)) { s.jämförda += 1; if (facit.get(n) === i.status) s.lika += 1; }
      }
      const poäng = scoreFromItems(items).score;
      s.poäng.push(poäng);
      rad.push(`${namn}: ${poäng ?? '—'}`);
    } catch (e) {
      s.trasiga += 1;
      rad.push(`${namn}: FEL ${e.message.slice(0, 60)}`);
    }
  }
  console.log(ad.title.slice(0, 34).padEnd(36), rad.join('  '));
}

console.log('\n%s', 'modell'.padEnd(21)
  + 'poäng/annons'.padEnd(14) + 'håller med'.padEnd(12)
  + 'belagda'.padEnd(10) + '$/annons'.padEnd(11) + 's/annons'.padEnd(10) + 'trasiga');
for (const [namn, s] of summa) {
  const enighet = s.jämförda ? `${Math.round(100 * s.lika / s.jämförda)}%` : '(facit)';
  const belägg = s.påståenden ? `${Math.round(100 * s.belagda / s.påståenden)}%` : '—';
  const medel = s.poäng.length ? (s.poäng.reduce((a, b) => a + (b ?? 0), 0) / s.poäng.length).toFixed(0) : '—';
  console.log(namn.padEnd(21)
    + String(medel).padEnd(14)
    + enighet.padEnd(12)
    + belägg.padEnd(10)
    + `$${(s.kostnad / prov.length).toFixed(4)}`.padEnd(11)
    + (s.tid / prov.length).toFixed(1).padEnd(10)
    + String(s.trasiga)
    + (s.tänk ? `   (${s.tänk} tänketokens)` : ''));
}
await pool.end();
