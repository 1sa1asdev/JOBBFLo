// Proves that reading an ad's requirements is each user's own, and that
// a read too thin to trust is never graded — without a single model call.
//
//   node scripts/prove-ad-reads.js
//
//   1. A grades an ad: A's reader is called, the read is stored as A's
//   2. B grades it: B reads it with B's own model, A's read is untouched
//   3. the same CV text at A and B: two checklists, not one shared
//   4. cheap read thin, better read good: graded
//   5. both reads thin: the grader is never called, the read is stored
//      as failed with its reason, and the error says so
//   6. the queue trying again costs nothing; "Försök igen" reads again
//   7. an ad with no text: no call, and the answer says "no text"
//   8. a closed ad's reads are released
//
// Reader and grader are fakes that count their calls. Every row it makes
// is removed again.
import 'dotenv/config';
import { pool } from '../src/db.js';
import * as checklist from '../src/checklist.js';
import { retireClosedAds } from '../src/refresh.js';

const KÖRNING = `${Date.now()}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(66)}${info ? ` ${info}` : ''}`);
};

// ---- an ad long enough for the thin-read test to apply (>1200 chars) ----
const KRAV = [
  'Du ska ha B-körkort',
  'Erfarenhet av lagerarbete i minst två år',
  'Truckkort A och B är ett krav',
  'Du talar och skriver svenska obehindrat',
  'Vana av WMS-system som Astro',
];
const fyllnad = 'Vi är ett växande logistikföretag med kunder i hela Norden och ett starkt fokus på kvalitet. ';
const LÅNG = `${KRAV.join('. ')}. ${fyllnad.repeat(16)}`;

// What a reader returns. good: five requirements quoted verbatim. thin:
// two, paraphrased — the shape the cheap model produces when it fails.
const BRA = {
  headline: 'Lagerarbetare', role: { title: 'Lagerarbetare', field: 'lager och logistik' },
  seniority: 'junior', years_required: null,
  requires: KRAV.map((k, i) => ({
    name: `krav ${i}`, field: 'lager och logistik', weight: 'krav', kind: 'teknik', evidence: k })),
  tasks: [], domains: [], languages: [], education_required: null,
  employment: { form: 'okänt', extent: 'okänt', start: null },
  location: { where: null, remote: 'okänt' }, dealbreakers: [],
};
const TUNN = {
  ...BRA,
  requires: [
    { name: 'körkort', weight: 'krav', kind: 'licens', evidence: 'kandidaten behöver körkort' },
    { name: 'lager', weight: 'krav', kind: 'erfarenhet', evidence: 'har jobbat på lager förut' },
  ],
};

// One fake reader per test, scripted per tier.
const läsare = (svar) => {
  const anrop = [];
  const f = async ({ profileId, tier }) => {
    anrop.push({ profileId, tier });
    const s = typeof svar === 'function' ? svar(tier) : svar;
    return structuredClone(s);
  };
  f.anrop = anrop;
  return f;
};
const bedömare = () => {
  const anrop = [];
  const f = async ({ profileId, messages, onModel }) => {
    anrop.push({ profileId });
    onModel?.('fejk:bedömare');
    const ids = [...messages[0].content.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    return { items: ids.map((id) => ({ id, status: 'okänt', cv_belagg: null, varfor: 'fejk' })) };
  };
  f.anrop = anrop;
  return f;
};

const städa = async () => {
  await pool.query(`DELETE FROM profile WHERE email LIKE 'proof+reads-%-${KÖRNING}@example.invalid'`);
  await pool.query(`DELETE FROM ads WHERE external_id LIKE 'prove-reads-${KÖRNING}%'`);
};

const profil = async (namn) => (await pool.query(
  `INSERT INTO profile (name, email) VALUES ($1, $2) RETURNING id`,
  [`Bevis ${namn}`, `proof+reads-${namn}-${KÖRNING}@example.invalid`])).rows[0].id;

let n = 0;
const annons = async (description) => (await pool.query(
  `INSERT INTO ads (source, external_id, fingerprint, title, employer, description)
   VALUES ('manual', $1, $1, 'Lagerarbetare', 'Bevislogistik AB', $2) RETURNING *`,
  [`prove-reads-${KÖRNING}-${n += 1}`, description])).rows[0];

const läsningar = async (adId) => {
  try {
    return (await pool.query(
      `SELECT profile_id, status, model, reason FROM ad_reads WHERE ad_id = $1`, [adId])).rows;
  } catch { return null; } // the table does not exist in the old code
};

const CV = 'Jag har B-körkort och har arbetat på lager i tre år.';
const bedöm = (ad, profileId, l, b, extra = {}) => checklist.checkAd(ad, {
  cvText: CV, cvProfile: null, profileId, läsare: l, fråga: b, ...extra });
const försök = async (fn) => { try { return { svar: await fn() }; } catch (e) { return { fel: e }; } };

try {
  await städa();
  const A = await profil('a');
  const B = await profil('b');

  // ---- 1 + 2: each user reads for themselves ----
  const X = await annons(LÅNG);
  const lA = läsare(BRA); const bA = bedömare();
  const rA = await försök(() => bedöm(X, A, lA, bA));
  kolla('1. A:s läsare anropas, med A som betalare',
    lA.anrop.length >= 1 && lA.anrop.every((a) => a.profileId === A),
    rA.fel ? rA.fel.message.slice(0, 60) : '');
  let r = await läsningar(X.id);
  kolla('1. läsningen sparas som A:s', r?.length === 1 && r[0].profile_id === A && r[0].status === 'ok');

  const lB = läsare(BRA); const bB = bedömare();
  await försök(() => bedöm(X, B, lB, bB));
  kolla('2. B läser själv, får inte A:s läsning', lB.anrop.length >= 1 && lB.anrop.every((a) => a.profileId === B));
  r = await läsningar(X.id);
  kolla('2. A:s och B:s läsningar ligger bredvid varandra',
    r?.length === 2 && r.some((x) => x.profile_id === A) && r.some((x) => x.profile_id === B));
  const igen = läsare(BRA);
  await försök(() => bedöm(X, A, igen, bedömare(), { force: true }));
  kolla('2. A:s nästa bedömning återanvänder A:s läsning', igen.anrop.length === 0);

  // ---- 3: the checklist cache is per user ----
  const { rows: [c] } = await pool.query(
    `SELECT count(*)::int AS n FROM ad_checks WHERE ad_id = $1`, [X.id]);
  kolla('3. samma CV hos A och B: två checklistor', c.n === 2, `${c.n} rader`);

  // ---- 4: cheap thin, better good → graded ----
  const Y = await annons(LÅNG);
  const lY = läsare((tier) => (tier === 'fast' ? TUNN : BRA)); const bY = bedömare();
  const rY = await försök(() => bedöm(Y, A, lY, bY));
  kolla('4. billig tunn, bättre bra → bedöms',
    !rY.fel && bY.anrop.length === 1 && lY.anrop.map((a) => a.tier).join() === 'fast,bulk',
    rY.fel?.message?.slice(0, 60) || lY.anrop.map((a) => a.tier).join());

  // ---- 5: both thin → never graded ----
  const Z = await annons(LÅNG);
  const lZ = läsare(TUNN); const bZ = bedömare();
  const rZ = await försök(() => bedöm(Z, A, lZ, bZ));
  kolla('5. båda läsningarna tunna → bedömaren anropas inte', lZ.anrop.length === 2 && bZ.anrop.length === 0,
    `${lZ.anrop.length} läsningar, ${bZ.anrop.length} bedömningar`);
  kolla('5. felet säger att annonsen inte kunde läsas',
    /kunde inte läsas tillförlitligt/i.test(rZ.fel?.message || '') && rZ.fel?.kod === 'OLÄSBAR',
    (rZ.fel?.message || 'inget fel').slice(0, 70));
  r = await läsningar(Z.id);
  kolla('5. läsningen sparas som misslyckad, med orsak',
    r?.length === 1 && r[0].status === 'misslyckad' && /krav/.test(r[0].reason || ''), r?.[0]?.reason || '');

  // ---- 6: retrying ----
  const lZ2 = läsare(BRA); const bZ2 = bedömare();
  const rZ2 = await försök(() => bedöm(Z, A, lZ2, bZ2));
  kolla('6. kön försöker igen: ingen ny läsning, ingen bedömning',
    lZ2.anrop.length === 0 && bZ2.anrop.length === 0 && rZ2.fel?.kod === 'OLÄSBAR');
  if (typeof checklist.glömMisslyckadeLäsningar === 'function') {
    await checklist.glömMisslyckadeLäsningar([Z.id], A);
    const rZ3 = await försök(() => bedöm(Z, A, lZ2, bZ2));
    kolla('6. "Försök igen" läser om och bedömer', !rZ3.fel && lZ2.anrop.length >= 1 && bZ2.anrop.length === 1,
      rZ3.fel?.message?.slice(0, 60) || '');
  } else {
    kolla('6. glömMisslyckadeLäsningar finns', false, 'saknas i den här koden');
  }

  // ---- 7: no text ----
  const T = await annons('');
  const lT = läsare(BRA); const bT = bedömare();
  const rT = await försök(() => bedöm(T, A, lT, bT));
  kolla('7. annons utan text: inga anrop', lT.anrop.length === 0 && bT.anrop.length === 0);
  kolla('7. svaret säger "ingen text", inte "inga krav"',
    /ingen text/i.test(rT.svar?.summary || '') && rT.svar?.score === null, rT.svar?.summary || rT.fel?.message || '');

  // ---- 8: closing releases the reads ----
  await pool.query(`UPDATE ads SET removed_at = now() WHERE id = $1`, [X.id]);
  await retireClosedAds();
  r = await läsningar(X.id);
  kolla('8. stängd annons: läsningarna släpps', r?.length === 0, `${r?.length ?? '?'} kvar`);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  await städa();
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
