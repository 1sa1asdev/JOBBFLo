// Proves the shared market counts right and gives nobody away.
//
//   node scripts/prove-marknad.js
//
// The Marknaden tab shows every user the same numbers, some of them
// built from what other users did. So:
//
//   1. the daily record counts new, closed and open ads and openings per
//      day exactly, and writing it twice gives the same rows
//   2. a user's pasted ad (source 'manual') is never counted
//   3. "N users applied" stays hidden below five different users — on an
//      ad and per field — and appears at five
//   4. a reply rate needs twenty applications from five users — counting
//      only letters that arrived, were not withdrawn and have had two
//      weeks to be answered — and shows rejections apart from interviews
//   5. a median closing time needs five closed ads
//   6. what the tab returns names no ad, employer or user
//
// On throwaway ads in a region and field of their own, removed again.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { byggMarknad, marknadsläge, antalSökande } from '../src/marknad.js';

const RUN = `${Date.now()}`;
const REGION = `bevis-reg-${RUN}`;
const FÄLT = `bevis-falt-${RUN}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(60)}${info ? ` ${info}` : ''}`);
};

const rader = { ads: [], profiler: [] };
const annons = async (n, { dagarSedan, stängdFör = null, deadlineFör = null, platser = null, källa = 'platsbanken' }) => {
  const raw = {
    id: `${RUN}-${n}`, headline: 'Bevis',
    occupation_field: { concept_id: FÄLT, label: 'Bevisområdet' },
    workplace_address: { region: 'Bevisregionen', region_concept_id: REGION },
    ...(platser ? { number_of_vacancies: platser } : {}),
  };
  const { rows: [a] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description, raw, region,
                      published_at, removed_at, deadline)
     VALUES ($1, $2, $2, 'Bevis', 'Hemliga Bevisbolaget AB', 'x', $3, 'Bevisregionen',
             now() - make_interval(days => $4),
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END,
             CASE WHEN $6::int IS NULL THEN NULL ELSE current_date - $6::int END)
     RETURNING id`,
    [källa, `prove-marknad-${RUN}-${n}`, JSON.stringify(raw), dagarSedan, stängdFör, deadlineFör]);
  rader.ads.push(a.id);
  return a.id;
};
const profil = async (n) => {
  const { rows: [p] } = await pool.query(
    `INSERT INTO profile (name, email) VALUES ($1, $2) RETURNING id`,
    [`Bevis ${n}`, `proof+marknad-${n}-${RUN}@example.invalid`]);
  rader.profiler.push(p.id);
  return p.id;
};
const sök = (adId, profileId, status = 'sent', dagarSedan = 1) => pool.query(
  `INSERT INTO applications (ad_id, profile_id, status, sent_at, sent_by, subject, letter_text)
   VALUES ($1, $2, $3, now() - make_interval(days => $4), 'user', 'x', 'x')`, [adId, profileId, status, dagarSedan]);
const fältRad = async () => (await marknadsläge({ regionId: REGION })).rader.find((r) => r.falt_id === FÄLT);

try {
  // ---- 1 + 2 ----
  const öppen = await annons(1, { dagarSedan: 3, platser: 4 });
  await annons(2, { dagarSedan: 5, stängdFör: 2 });
  await annons(3, { dagarSedan: 1, deadlineFör: 1 });
  await annons(4, { dagarSedan: 3, källa: 'manual' });

  await byggMarknad();
  const dag = async (n) => (await pool.query(
    `SELECT nya, platser, stangda, oppna FROM marknad_dag
     WHERE region_id = $1 AND falt_id = $2 AND dag = (now() AT TIME ZONE 'Europe/Stockholm')::date - $3::int`,
    [REGION, FÄLT, n])).rows[0] || { nya: 0, platser: 0, stangda: 0, oppna: 0 };
  const d3 = await dag(3); const d2 = await dag(2); const d1 = await dag(1);
  kolla('1. ny annons räknas på sin dag, med sina platser', d3.nya === 1 && d3.platser === 4, JSON.stringify(d3));
  kolla('1. stängd annons räknas på stängningsdagen', d2.stangda === 1 && d2.oppna === 1, JSON.stringify(d2));
  kolla('1. öppna dag för dag — utgången deadline räknas inte', d1.oppna === 2, JSON.stringify(d1));
  const före = JSON.stringify(await pool.query(`SELECT * FROM marknad_dag WHERE region_id = $1 ORDER BY dag, falt_id`, [REGION]).then((r) => r.rows.map(({ uppdaterad, ...x }) => x)));
  await byggMarknad();
  const efter = JSON.stringify(await pool.query(`SELECT * FROM marknad_dag WHERE region_id = $1 ORDER BY dag, falt_id`, [REGION]).then((r) => r.rows.map(({ uppdaterad, ...x }) => x)));
  kolla('1. att skriva två gånger ger samma rader', före === efter);

  const r0 = await fältRad();
  kolla('2. en inklistrad annons räknas aldrig', r0.nya_7 === 3 && r0.oppna === 1, `nya ${r0.nya_7}, öppna ${r0.oppna}`);
  kolla('5. medianen visas inte på en enda stängd annons', r0.median_dagar === null);

  // ---- 3 ----
  const p = [];
  for (let i = 0; i < 5; i += 1) p.push(await profil(i));
  for (let i = 0; i < 4; i += 1) await sök(öppen, p[i]);
  kolla('3. fyra sökande: antalet på annonsen döljs', (await antalSökande(öppen)) === null);
  kolla('3. fyra sökande: antalet per område döljs', (await fältRad()).sokta_30 === null);
  await sök(öppen, p[4]);
  kolla('3. fem sökande: antalet visas', (await antalSökande(öppen)) === 5 && (await fältRad()).sokta_30 === 5);

  // ---- 4 ----
  // A reply rate is a share of letters that arrived, were not taken back
  // and have had SVARSTID days to be answered. The five letters above
  // are a day old; add 14 that are twenty days old, and five that
  // bounced or were withdrawn — 24 sent, 14 that count.
  const svarAds = [];
  for (let i = 0; i < 25; i += 1) svarAds.push(await annons(100 + i, { dagarSedan: 30 }));
  for (let i = 0; i < 14; i += 1) await sök(svarAds[i], p[i % 5], i < 6 ? 'replied' : 'sent', 20);
  for (let i = 14; i < 19; i += 1) await sök(svarAds[i], p[i % 5], i < 17 ? 'undeliverable' : 'withdrawn', 20);
  const r14 = await fältRad();
  kolla('4. färska, studsade och återkallade räknas inte: ingen svarsandel', r14.svar === null, '24 skickade, 14 räknas');
  // six more that count — one interview, two rejections — make twenty
  for (let i = 19; i < 25; i += 1) {
    await sök(svarAds[i], p[i % 5], i === 19 ? 'interview' : i < 22 ? 'rejected' : 'sent', 20);
  }
  const r20 = await fältRad();
  kolla('4. tjugo som räknas, från fem användare: andelen visas', r20.svar?.av === 20, JSON.stringify(r20.svar));
  kolla('4. svar = svar + intervju + nej; nej visas för sig',
    r20.svar?.andel === 45 && r20.svar.intervju === 5 && r20.svar.nej === 10, '9 av 20 svarade, 1 intervju, 2 nej');

  // ---- 6 ----
  const hela = JSON.stringify(await marknadsläge({ regionId: REGION }));
  const läckor = [...rader.ads, ...rader.profiler, 'Hemliga Bevisbolaget', '@example.invalid'].filter((s) => hela.includes(s));
  kolla('6. svaret nämner ingen annons, arbetsgivare eller användare', läckor.length === 0, läckor.join(', '));
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  if (rader.profiler.length) await pool.query(`DELETE FROM applications WHERE profile_id = ANY($1)`, [rader.profiler]).catch(() => {});
  if (rader.ads.length) await pool.query(`DELETE FROM ads WHERE id = ANY($1)`, [rader.ads]).catch(() => {});
  if (rader.profiler.length) await pool.query(`DELETE FROM profile WHERE id = ANY($1)`, [rader.profiler]).catch(() => {});
  await pool.query(`DELETE FROM marknad_dag WHERE region_id = $1`, [REGION]).catch(() => {});
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
