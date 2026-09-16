// Proves the checklist end to end on a temporary ad, with the model's
// answer injected — so the parts that must not be trusted to a model
// (the arithmetic, the verbatim check, the reuse) are tested without
// one, and keep being testable when a key runs out.
//
// Cleans up every row it makes.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { checkAd, tillMatchResult } from '../src/checklist.js';
import { renderCvProfile } from '../src/cvprofile.js';

const { rows: [p] } = await pool.query(`SELECT id, cv_text, cv_profile FROM profile LIMIT 1`);
if (!p?.cv_text) { console.log('inget CV i profilen'); process.exit(0); }

const profil = {
  headline: 'Frontendutvecklare till provbolaget',
  role: { title: 'Frontendutvecklare', field: 'IT' },
  seniority: 'junior',
  years_required: null,
  requires: [
    { name: 'React', field: 'IT', weight: 'krav', evidence: 'Du kan React', verbatim: true },
    { name: 'Node.js', field: 'IT', weight: 'krav', evidence: 'erfarenhet av Node.js', verbatim: true },
    { name: 'Körkort B', field: 'transport', weight: 'krav', evidence: 'B-körkort krävs', verbatim: true },
    { name: 'Docker', field: 'IT', weight: 'meriterande', evidence: 'gärna Docker', verbatim: true },
  ],
  tasks: [], domains: [], languages: [],
  education_required: null,
  employment: { form: 'okänt', extent: 'okänt', start: null },
  location: { where: 'Stockholm', remote: 'okänt' },
  dealbreakers: ['Körkort B'],
};

const { rows: [ad] } = await pool.query(
  `INSERT INTO ads (source, external_id, fingerprint, title, employer, municipality,
     description, published_at, raw, ad_profile)
   VALUES ('manual', $1, $2, 'Frontendutvecklare', 'Provbolaget AB', 'Stockholm',
     'Du kan React och har erfarenhet av Node.js. B-körkort krävs. Vi ser gärna Docker.',
     now(), '{}'::jsonb, $3::jsonb) RETURNING *`,
  [`prov-krav-${Date.now()}`, `prov${Date.now()}`, JSON.stringify(profil)]);

// What a model would answer. One quote is verbatim from the CV, one is
// invented — the invented one must lose its evidence AND its status.
const påhittat = 'Tio års erfarenhet som teknisk chef på Spotify';
// Quotes are checked against what the model was shown — the rendered
// CV profile, not the raw CV text. A test that quotes the raw text
// proves nothing about the check.
const cvRenderad = renderCvProfile(p.cv_profile) || p.cv_text;
const äkta = (cvRenderad.match(/[A-Za-zÅÄÖåäö0-9.+#]+(?:\s+[A-Za-zÅÄÖåäö0-9.+#]+){3,6}/) || [''])[0];

const svar = {
  items: [
    { id: 0, status: 'uppfyllt', cv_belagg: äkta, varfor: 'finns i CV:t' },
    { id: 1, status: 'uppfyllt', cv_belagg: påhittat, varfor: 'påhittat belägg' },
    { id: 2, status: 'saknas', cv_belagg: null, varfor: 'inget körkort i CV:t' },
    { id: 3, status: 'okänt', cv_belagg: null, varfor: 'nämns inte' },
  ],
};

let anrop = 0;
const fråga = async () => { anrop += 1; return svar; };

try {
  const rad = await checkAd(ad, {
    cvText: p.cv_text, cvProfile: p.cv_profile, fråga,
  });
  console.log(`poäng ${rad.score} — ${rad.summary}`);
  for (const i of rad.items) {
    console.log(`  ${i.status.padEnd(9)} ${i.name.padEnd(18)} belägg: ${i.cv_belagg ? 'ja' : '—'}`);
  }
  const hittepå = rad.items[1];
  console.log(`påhittat belägg avvisat: ${hittepå.cv_belagg === null && hittepå.status !== 'uppfyllt'}`);
  console.log(`dealbreaker sänker taket: ${rad.score <= 35} (must_missing ${JSON.stringify(rad.must_missing)})`);

  const igen = await checkAd(ad, { cvText: p.cv_text, cvProfile: p.cv_profile, fråga });
  console.log(`återanvänd utan modellanrop: ${Boolean(igen.återanvänd)} (anrop totalt ${anrop})`);

  const medKampanjkrav = await checkAd(ad, {
    cvText: p.cv_text, cvProfile: p.cv_profile, mustCriteria: 'bara juniora roller',
    fråga: async () => ({ items: [...svar.items, { id: 4, status: 'uppfyllt', cv_belagg: äkta, varfor: 'junior' }] }),
  });
  console.log(`kampanjkrav egen rad: ${medKampanjkrav.cv_key !== rad.cv_key}`
    + ` (${medKampanjkrav.items.length} krav mot ${rad.items.length})`);

  const ut = tillMatchResult(rad);
  console.log(`till match_results: ${ut.matched.length} matchade, ${ut.flags.length} flaggor,`
    + ` alla citat ur annonsen: ${[...ut.matched, ...ut.flags].every((x) => !x.quote || ad.description.includes(x.quote))}`);
} finally {
  await pool.query(`DELETE FROM ads WHERE id = $1`, [ad.id]);
  console.log('städat: provannonsen borttagen');
  await pool.end();
}
