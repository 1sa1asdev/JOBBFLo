// Proves Arbetsförmedlingen's forecast is loaded whole and shown right.
//
//   node scripts/prove-yrkesbarometer.js
//
//   1. a broken or partial file is refused, and nothing of it is stored
//   2. the janitor loads the new edition, the one before it and the
//      occupation mapping — once; a second run loads nothing
//   3. best and worst lists: AF's chances decide which list, open ads
//      decide the order, "medelstora" is in neither
//   4. a county's own assessment wins; without one, the national one
//   5. better or worse than the edition before is marked
//   6. the search card: the search's most common occupations, in the
//      county most of its ads are in — all of Sweden when they spread
//
// Against a fake download, as editions 2099-1 and 2099-2 (newer than any
// real one), on throwaway ads, removed again.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { hämtaYrkesbarometer, kontrollera, föregåendeOmgång, yrkesläge, sökläge } from '../src/yrkesbarometer.js';

const RUN = `${Date.now()}`;
const SKÅNE = 'CaRE_1nn_cSU';      // county 12 in lan_region
const STOCKHOLM = 'CifL_Rzy_Mku';   // county 01
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(62)}${info ? ` ${info}` : ''}`);
};

// Seven occupations that matter, plus filler so an edition is whole.
//   STOR_A  stora, many ads        STOR_B  stora, fewer ads
//   LITEN   små                    MEDEL   medelstora
//   LÄNET   national små, but stora in Skåne (county 12)
//   VÄNDE   små last edition, stora now; SJÖNK the reverse
const YRKEN = ['STOR_A', 'STOR_B', 'LITEN', 'MEDEL', 'LANET', 'VANDE', 'SJONK'];
const NU = { STOR_A: 'stora', STOR_B: 'stora', LITEN: 'små', MEDEL: 'medelstora', LANET: 'små', VANDE: 'stora', SJONK: 'små' };
const FÖRRA = { ...NU, VANDE: 'små', SJONK: 'stora' };
const id = (y) => `bevis_${y}_${RUN}`;
const upplaga = (omgång, läge) => {
  const rader = YRKEN.map((y) => ({
    omgang: omgång, yb_concept_id: id(y), yb_yrke: `Bevisyrke ${y}`, yrkesomrade: 'Bevis', lan: '00',
    jobbmojligheter: läge[y], rekryteringssituation: 'balans', prognos: 'öka',
    text_jobbmojligheter: `Arbetsförmedlingens text om ${y}`,
  }));
  rader.push({ ...rader[YRKEN.indexOf('LANET')], lan: '12', jobbmojligheter: 'stora', text_jobbmojligheter: 'Stora i Skåne' });
  for (let i = 0; rader.length < 1000; i += 1) {
    rader.push({ omgang: omgång, yb_concept_id: `bevis_fyll${i}_${RUN}`, yb_yrke: `Fyll ${i}`, lan: '00', jobbmojligheter: null });
  }
  return rader;
};
const RELATIONER = { relationer: [
  ...YRKEN.map((y) => ({ concept_id: `bevis-yrke-${y}-${RUN}`, yb_id: `yb_${id(y)}` })),
  ...Array.from({ length: 100 }, (_, i) => ({ concept_id: `bevis-fyll-${i}-${RUN}`, yb_id: `yb_bevis_fyll${i}_${RUN}` })),
] };

let filer = {};
const hämta = async (url) => {
  const namn = url.split('/prognoser/')[1];
  if (!(namn in filer)) return new Response('', { status: 404 });
  return new Response(JSON.stringify(filer[namn]), { status: 200 });
};

const adIds = [];
let profilId = null;
const annonser = async (yrke, antal, region) => {
  for (let i = 0; i < antal; i += 1) {
    const raw = { id: `${RUN}-${yrke}-${region}-${i}`, occupation: { concept_id: `bevis-yrke-${yrke}-${RUN}` },
      workplace_address: { region_concept_id: region } };
    const { rows: [a] } = await pool.query(
      `INSERT INTO ads (source, external_id, fingerprint, title, employer, description, raw, published_at)
       VALUES ('platsbanken', $1, $1, 'Bevis', 'Bevis AB', 'x', $2, now() - interval '2 days') RETURNING id`,
      [`prove-yb-${raw.id}`, JSON.stringify(raw)]);
    adIds.push(a.id);
  }
};

try {
  // ---- 1 ----
  kolla('1. omgångarna räknas bakåt', föregåendeOmgång('2026-1') === '2025-2' && föregåendeOmgång('2025-2') === '2025-1');
  const vägrar = (rader) => { try { kontrollera(rader); return false; } catch { return true; } };
  kolla('1. för få rader vägras', vägrar(upplaga('2099-2', NU).slice(0, 500)));
  kolla('1. två omgångar i samma fil vägras', vägrar([...upplaga('2099-2', NU).slice(0, 600), ...upplaga('2099-1', NU).slice(0, 600)]));
  kolla('1. okänt värde vägras', vägrar(upplaga('2099-2', { ...NU, LITEN: 'jättestora' })));
  filer = { 'yrkesbarometer.json': upplaga('2099-2', { ...NU, LITEN: 'jättestora' }) };
  const trasig = await hämtaYrkesbarometer({ hämta }).then(() => false, () => true);
  const lagrat = (await pool.query(`SELECT count(*)::int AS n FROM yrkesprognos WHERE omgang LIKE '2099-%'`)).rows[0].n;
  kolla('1. en trasig fil lagras inte alls', trasig && lagrat === 0, `${lagrat} rader`);

  // ---- 2 ----
  filer = {
    'yrkesbarometer.json': upplaga('2099-2', NU),
    'yrkesbarometer_relationer.json': RELATIONER,
    'historiska/yrkesbarometer_2099-1.json': upplaga('2099-1', FÖRRA),
  };
  const r1 = await hämtaYrkesbarometer({ hämta });
  kolla('2. ny omgång, den förra och kopplingen läses in', r1.nya.join() === '2099-2,2099-1' && r1.relationer === YRKEN.length + 100,
    JSON.stringify(r1));
  const r2 = await hämtaYrkesbarometer({ hämta });
  kolla('2. nästa körning läser inget nytt', r2.nya.length === 0 && !r2.relationer, JSON.stringify(r2));

  // ---- 3–5 ----
  await annonser('STOR_A', 5, SKÅNE);
  await annonser('STOR_B', 2, SKÅNE);
  await annonser('LITEN', 3, SKÅNE);
  await annonser('MEDEL', 9, SKÅNE);
  await annonser('LANET', 4, SKÅNE);
  await annonser('VANDE', 1, SKÅNE);
  await annonser('SJONK', 1, SKÅNE);
  const sk = await yrkesläge({ regionId: SKÅNE });
  const namn = (l) => l.map((y) => y.yrke.replace('Bevisyrke ', ''));
  kolla('3. bäst läge: stora möjligheter, flest annonser först', namn(sk.bast).join() === 'STOR_A,LANET,STOR_B,VANDE',
    namn(sk.bast).join());
  kolla('3. sämst läge: små möjligheter', namn(sk.samst).join() === 'LITEN,SJONK', namn(sk.samst).join());
  kolla('3. medelstora finns i ingen av listorna', ![...sk.bast, ...sk.samst].some((y) => y.yrke.endsWith('MEDEL')));
  kolla('4. länets egen bedömning går före den nationella', sk.bast.find((y) => y.yrke.endsWith('LANET'))?.lokal === true);
  const sv = await yrkesläge({ regionId: null });
  kolla('4. i hela Sverige gäller den nationella', namn(sv.samst).includes('LANET') && !namn(sv.bast).includes('LANET'));
  const st = await yrkesläge({ regionId: STOCKHOLM });
  kolla('4. län utan egen bedömning: den nationella', namn(st.samst).includes('LANET'));
  kolla('5. bättre och sämre än förra omgången märks',
    sk.bast.find((y) => y.yrke.endsWith('VANDE'))?.andring === 'bättre'
    && sk.samst.find((y) => y.yrke.endsWith('SJONK'))?.andring === 'sämre'
    && sk.bast.find((y) => y.yrke.endsWith('STOR_A'))?.andring === null);

  // ---- 6 ----
  const { rows: [p] } = await pool.query(
    `INSERT INTO profile (name, email) VALUES ('Bevis', $1) RETURNING id`, [`proof+yb-${RUN}@example.invalid`]);
  profilId = p.id;
  const { rows: [s] } = await pool.query(
    `INSERT INTO searches (profile_id, name, criteria_text) VALUES ($1, 'Bevis', 'x') RETURNING id`, [profilId]);
  const iSökningen = adIds.slice(0, 5 + 2 + 3);   // STOR_A ×5, STOR_B ×2, LITEN ×3, all in Skåne
  await pool.query(`INSERT INTO match_results (search_id, ad_id) SELECT $1, unnest($2::uuid[])`, [s.id, iSökningen]);
  const kort = await sökläge(s.id);
  kolla('6. kortet: sökningens vanligaste yrken, i länet där annonserna är',
    kort?.region === 'Skåne län' && namn(kort.yrken).join() === 'STOR_A,LITEN,STOR_B', `${kort?.region}: ${namn(kort?.yrken || []).join()}`);
  kolla('6. kortets text är Arbetsförmedlingens egen', kort?.yrken[0].text === 'Arbetsförmedlingens text om STOR_A');
  await annonser('STOR_A', 8, STOCKHOLM);
  await pool.query(`INSERT INTO match_results (search_id, ad_id) SELECT $1, unnest($2::uuid[])`, [s.id, adIds.slice(-8)]);
  const spritt = await sökläge(s.id);
  kolla('6. annonser utspridda över landet: hela Sverige', spritt?.region === null, `${10} i Skåne, 8 i Stockholm`);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  if (profilId) await pool.query(`DELETE FROM searches WHERE profile_id = $1`, [profilId]).catch(() => {});
  if (adIds.length) await pool.query(`DELETE FROM match_results WHERE ad_id = ANY($1)`, [adIds]).catch(() => {});
  if (adIds.length) await pool.query(`DELETE FROM ads WHERE id = ANY($1)`, [adIds]).catch(() => {});
  if (profilId) await pool.query(`DELETE FROM profile WHERE id = $1`, [profilId]).catch(() => {});
  await pool.query(`DELETE FROM yrkesprognos WHERE omgang LIKE '2099-%'`).catch(() => {});
  await pool.query(`DELETE FROM yrkesprognos_yrke WHERE omgang LIKE '2099-%'`).catch(() => {});
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
