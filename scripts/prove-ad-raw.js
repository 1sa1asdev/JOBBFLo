// Proves ads.raw keeps everything the app reads, and nothing it doesn't.
//
//   node scripts/prove-ad-raw.js
//
// raw used to be the whole JobTech ad: the description three times over,
// and 211 of 663 MB locally — the free Supabase plan holds 500. Since
// migration 062 a trigger keeps only the paths the app reads
// (public.ad_raw_slim). The danger of that is quiet: code that starts
// reading a new raw path gets null and a filter matches nothing. So:
//
//   1. every raw path read anywhere — src/, app/, lib/ and the schema's
//      indexes, views and generated columns — is still there after
//      slimming a full ad
//   2. the description is gone from raw, and still whole in its column
//   3. slimming is idempotent, so the same ad again is no write at all —
//      and neither is a change only in a field nobody reads
//   4. an edited description IS a change, though raw no longer holds it
//   5. lat/lon and postcode_coords still come out of the slim raw
//   6. a pasted (manual) ad's raw is left as the user pasted it
//   7. the batch write the feed and the snapshot use (upsertAds) leaves
//      the same rows, rewrites the same rows and answers the same as
//      writing the ads one at a time
//   8. what is known to make Postgres refuse a row (an unreadable date,
//      a NUL, half an emoji, coordinates that are not numbers) is put
//      right before sending, so the batch goes in as one statement
//   9. one ad that cannot be written anyway does not cost its batch
//      the rest
//
// On a throwaway ad with a synthetic JobTech payload.
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../src/db.js';
import { mapAd, upsertAd, upsertAds } from '../src/fetchJobs.js';

const ID = `bevis-raw-${process.pid}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(62)}${info ? ` ${info}` : ''}`);
};

// A JobTech ad with every field the API sends filled in (shape copied
// from a real one; the values are made up).
const begrepp = (label, id) => ({ label, concept_id: id, legacy_ams_taxonomy_id: '1' });
const text = 'Vi söker en sjuksköterska till vår avdelning. '.repeat(80);
const annons = () => ({
  id: ID,
  label: [],
  access: null,
  removed: false,
  duration: begrepp('Tills vidare', 'dur1'),
  employer: { url: 'https://exempel.invalid', name: 'Bevis AB', email: null, workplace: 'Bevis',
    phone_number: '000', organization_number: '5560000000' },
  headline: 'Sjuksköterska',
  logo_url: 'https://exempel.invalid/logo.png',
  must_have: {
    skills: [{ label: 'Operation', weight: 10, concept_id: 'sk1', legacy_ams_taxonomy_id: '9' }],
    education: [], languages: [{ label: 'Svenska', weight: 5, concept_id: 'la1', legacy_ams_taxonomy_id: '1' }],
    education_level: [], work_experiences: [],
  },
  timestamp: 1791361855720,
  occupation: begrepp('Sjuksköterska', 'occ1'),
  description: { text, needs: null, conditions: 'Heltid', requirements: null,
    text_formatted: `<p>${text}</p>`, company_information: 'Om oss' },
  external_id: null,
  original_id: null,
  salary_type: begrepp('Fast lön', 'sal1'),
  source_type: 'VIA_ANNONSERA',
  webpage_url: 'https://arbetsformedlingen.se/x',
  nice_to_have: { skills: [], education: [], languages: [], education_level: [], work_experiences: [] },
  removed_date: null,
  scope_of_work: { max: 100, min: 100 },
  driving_license: null,
  employment_type: begrepp('Tillsvidareanställning', 'emp1'),
  occupation_field: begrepp('Hälso- och sjukvård', 'fld1'),
  occupation_group: begrepp('Sjuksköterskor', 'grp1'),
  publication_date: '2026-10-07T10:22:55',
  access_to_own_car: false,
  workplace_address: { city: 'ÖREBRO', region: 'Örebro län', country: 'Sverige', postcode: '701 85',
    coordinates: [15.1076901, 59.2457525], region_code: '18', country_code: '199',
    municipality: 'Örebro', street_address: 'Storgatan 1', municipality_code: '1880',
    region_concept_id: 'reg1', country_concept_id: 'se1', municipality_concept_id: 'mun1' },
  salary_description: 'Enligt avtal',
  working_hours_type: begrepp('Heltid', 'wh1'),
  application_details: { url: null, email: 'jobb@exempel.invalid', other: null, via_af: false,
    reference: 'x', information: null },
  experience_required: true,
  identified_language: 'sv',
  number_of_vacancies: 1,
  application_contacts: [],
  application_deadline: '2099-11-06T23:59:59',
  last_publication_date: '2099-11-06T23:59:59',
  driving_license_required: false,
});

// ---- the paths read, found in the code and the schema ----
function* filer(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* filer(p);
    else if (/\.(js|jsx)$/.test(e.name)) yield p;
  }
}
const vägar = new Map(); // "a.b" → where it was read
const läs = (kod, var_) => {
  // SQL: raw->'a'->>'b', raw->>'a', raw -> 'a'::text (pg_dump's spelling)
  const sql = kod.replace(/::text/g, '').replace(/[()]/g, '').replace(/\s+/g, '');
  for (const m of sql.matchAll(/\braw((?:->>?'\w+')+)/g)) {
    const väg = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).join('.');
    if (!vägar.has(väg)) vägar.set(väg, var_);
  }
  // JS: ad.raw?.a?.b
  for (const m of kod.matchAll(/\.raw((?:\?\.\w+)+)/g)) {
    const väg = m[1].split('?.').filter(Boolean).join('.');
    if (!vägar.has(väg)) vägar.set(väg, var_);
  }
};
for (const dir of ['src', 'app', 'lib']) for (const f of filer(dir)) läs(readFileSync(f, 'utf8'), f);
läs(readFileSync('db/schema.sql', 'utf8'), 'db/schema.sql');

const hämta = (o, väg) => väg.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

try {
  await pool.query(`DELETE FROM ads WHERE source = 'platsbanken' AND external_id = $1`, [ID]);

  const första = await upsertAd(pool, mapAd(annons()));
  const { rows: [rad] } = await pool.query(
    `SELECT id, raw, description, lat, lon, pg_column_size(raw) AS byte,
            pg_column_size($2::jsonb) AS hela, public.ad_raw_slim(raw) = raw AS idempotent
     FROM ads WHERE id = $1`, [första.id, JSON.stringify(annons())]);

  // ---- 1 ----
  const saknas = [...vägar].filter(([väg]) => hämta(rad.raw, väg) == null);
  kolla(`1. alla ${vägar.size} raw-vägar som läses finns kvar`, vägar.size > 5 && !saknas.length,
    saknas.map(([v, f]) => `${v} (${f})`).join(', '));

  // ---- 2 ----
  kolla('2. beskrivningen finns inte i raw', !('description' in rad.raw));
  kolla('2. men hel i sin kolumn', rad.description === text);
  kolla('2. raw är en bråkdel av API-svaret', rad.byte < rad.hela / 3, `${rad.byte} av ${rad.hela} byte`);
  kolla('2. kompetenslistorna finns kvar, och inget tomt',
    rad.raw.must_have?.skills?.[0]?.concept_id === 'sk1' && !('nice_to_have' in rad.raw)
    && !('education' in rad.raw.must_have));

  // ---- 3 ----
  kolla('3. att banta en bantad annons ändrar inget', rad.idempotent === true);
  const igen = await upsertAd(pool, mapAd(annons()));
  kolla('3. samma annons igen skrivs inte', igen.unchanged === true);
  const brus = { ...annons(), timestamp: 1, last_publication_date: '2099-12-01T00:00:00', logo_url: null };
  kolla('3. en ändring bara i fält ingen läser skrivs inte', (await upsertAd(pool, mapAd(brus))).unchanged === true);

  // ---- 4 ----
  const ny = annons();
  ny.description = { ...ny.description, text: 'Ny text från arbetsgivaren.' };
  const ändrad = await upsertAd(pool, mapAd(ny));
  const { rows: [efter] } = await pool.query(`SELECT description FROM ads WHERE id = $1`, [första.id]);
  kolla('4. en ändrad beskrivning är en ändring', ändrad.unchanged === false && efter.description === 'Ny text från arbetsgivaren.');

  // ---- 5 ----
  kolla('5. lat/lon räknas ur den bantade raw', rad.lat === 59.2457525 && rad.lon === 15.1076901);
  const { rows: [pk] } = await pool.query(`SELECT ads FROM postcode_coords WHERE postcode = '70185'`);
  kolla('5. postcode_coords hittar postnumret', Number(pk?.ads) >= 1);

  // ---- 6 ----
  const klistrad = { text: 'inklistrad annons', description: { text: 'behålls' } };
  const { rows: [m] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description, raw)
     VALUES ('manual', $1, $1, 'x', 'x', 'x', $2) RETURNING raw`, [`${ID}-m`, JSON.stringify(klistrad)]);
  kolla('6. en inklistrad annons raw lämnas som den var', JSON.stringify(m.raw) === JSON.stringify(klistrad));

  // ---- 7 + 8 ----
  // The same mix written one at a time and as one batch, from the same
  // starting rows, inside a transaction rolled back after each.
  const variant = (n, ändra = {}) => mapAd({ ...annons(), id: `${ID}-b${n}`, ...ändra });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (let n = 0; n < 6; n += 1) await upsertAd(c, variant(n));
    const blandning = [
      variant(0), variant(1),                                              // unchanged
      variant(2, { headline: 'Undersköterska' }),                          // changed
      variant(3, { removed: true, removed_date: '2026-10-30T12:00:00' }),  // withdrawn
      variant(6), variant(7),                                              // new
      variant(4, { headline: 'Först' }), variant(4, { headline: 'Sist' }), // the same ad twice
    ];
    const nycklar = [...new Set(blandning.map((a) => a.external_id))];
    const läge = async () => (await c.query(
      `SELECT external_id, xmin::text AS xmin, md5(row(title, description, deadline, removed_at,
              ats_vendor, raw, fingerprint, employer, published_at)::text) AS h
       FROM ads WHERE external_id = ANY($1) ORDER BY external_id`, [nycklar])).rows;
    const före = new Map((await läge()).map((r) => [r.external_id, r.xmin]));
    const kör = async (sätt) => {
      await c.query('SAVEPOINT jfr');
      const utfall = (await sätt()).map((r) => (!r ? 'null' : r.inserted ? 'ny' : r.unchanged ? 'samma' : 'ändrad'));
      const rader = await läge();
      await c.query('ROLLBACK TO SAVEPOINT jfr');
      return { utfall, innehåll: rader.map((r) => r.h), skrivna: rader.filter((r) => före.get(r.external_id) !== r.xmin).map((r) => r.external_id) };
    };
    const enOchEn = await kör(async () => { const ut = []; for (const a of blandning) ut.push(await upsertAd(c, a)); return ut; });
    const klump = await kör(() => upsertAds(c, blandning));
    kolla('7. i klump: samma rader i tabellen som en och en', JSON.stringify(klump.innehåll) === JSON.stringify(enOchEn.innehåll));
    kolla('7. samma rader skrivs om — och de oförändrade inte', JSON.stringify(klump.skrivna) === JSON.stringify(enOchEn.skrivna)
      && !klump.skrivna.includes(`${ID}-b0`), klump.skrivna.length + ' omskrivna');
    // One difference, on purpose: the first of two copies of an ad was
    // written and then overwritten by the loop, and is never written at
    // all by the batch — which says so.
    const väntat = [...enOchEn.utfall];
    väntat[6] = 'samma';
    kolla('7. samma svar för varje annons (utom en överspelad kopia)',
      JSON.stringify(klump.utfall) === JSON.stringify(väntat), klump.utfall.join(' '));
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }

  // ---- 8 ----
  // Everything known to make Postgres refuse a row, each in its own ad.
  // All of them go in, in the one statement: counted, so a batch that
  // quietly fell back to one at a time would not pass.
  let satser = 0;
  const räknad = { query: (...a) => { satser += 1; return pool.query(...a); } };
  const knepiga = [
    variant(11, { publication_date: 'inte ett datum' }),
    variant(12, { application_deadline: '2026-02-30T23:59:59' }),
    variant(13, { headline: 'Kock\u0000 sökes', description: { text: 'nul\u0000tecken' } }),
    variant(14, { employer: { name: 'Halv \ud83d emoji AB' } }),
    variant(15, { workplace_address: { ...annons().workplace_address, coordinates: ['öst', 'väst'] } }),
    variant(16, { removed: true, removed_date: 'igår' }),
  ];
  const svar8 = await upsertAds(räknad, knepiga);
  const { rows: inne } = await pool.query(
    `SELECT external_id, published_at, deadline, title, lat, removed_at IS NOT NULL AS stängd
     FROM ads WHERE external_id LIKE $1 ORDER BY external_id`, [`${ID}-b1_`]);
  const r8 = Object.fromEntries(inne.map((r) => [r.external_id.slice(-3), r]));
  kolla('8. kända fel rättas före skrivning: alla in, i en sats',
    svar8.every((r) => r?.inserted) && satser === 1, `${inne.length} av ${knepiga.length}, ${satser} sats`);
  kolla('8. oläsbart datum blir inget datum', r8.b11?.published_at === null && r8.b12?.deadline === null);
  kolla('8. NUL-tecken tas bort, resten av texten blir kvar', r8.b13?.title === 'Kock sökes');
  kolla('8. koordinater som inte är tal blir inga koordinater', r8.b15 && r8.b15.lat === null);
  kolla('8. tillbakadragen med oläsbart datum är ändå stängd', r8.b16?.stängd === true);

  // ---- 9 ----
  // Something the check did not foresee — here an ad that bypassed
  // mapAd — still costs only itself. Outside a transaction, as the feed
  // and the snapshot write: inside one, the failed statement would have
  // aborted it for everyone.
  const förbi = { ...variant(17), raw: { ...annons(), workplace_address: { coordinates: ['x', 'y'] } } };
  const tyst = console.error;
  console.error = () => {};
  const medTrasig = await upsertAds(pool, [variant(9), förbi, variant(10)]);
  const utanRubrik = await upsertAds(pool, [{ ...variant(18), title: null }]);
  console.error = tyst;
  kolla('9. en trasig annons kostar inte de andra deras skrivning',
    medTrasig[0]?.inserted === true && medTrasig[1] === null && medTrasig[2]?.inserted === true);
  kolla('9. en annons utan rubrik skickas inte alls', utanRubrik[0] === null);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  await pool.query(`DELETE FROM ads WHERE external_id = $1 OR external_id LIKE $2`, [ID, `${ID}-%`]).catch(() => {});
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
