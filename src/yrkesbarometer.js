import { pool } from './db.js';

// ------------------------------------------------------------
// Arbetsförmedlingen's occupational forecast — Yrkesbarometern, open
// data (CC0) — held up next to the pool:
//
//   Marknaden    the five best and five worst placed occupations,
//                ranked by AF's chances of work first and by how many
//                open ads they have right now second
//   Sökning      how the market looks for the occupations a search
//                actually finds, in its county
//
// The text shown is AF's own assessment, never a model's: the chat card
// is built from these rows, so it cannot invent a forecast and costs
// nothing to show.
//
// Two editions a year. The janitor loads a new one when it appears, and
// the one before it, so "worse than last time" is there from day one.
// Every edition is kept (yrkesprognos.omgang).
// ------------------------------------------------------------

export const YB_BAS = 'https://data.jobtechdev.se/prognoser';
const JOBB = ['små', 'medelstora', 'stora'];
const MIN_RADER = 1000;   // a whole edition is ~4800 rows; less is a broken download

// 2026-1 → 2025-2 → 2025-1
export const föregåendeOmgång = (o) => {
  const [år, del] = String(o).split('-').map(Number);
  return del === 2 ? `${år}-1` : `${år - 1}-2`;
};

async function läsJson(hämta, url) {
  const svar = await hämta(url, { signal: AbortSignal.timeout(60_000) });
  if (!svar.ok) throw new Error(`${url.split('/').pop()}: HTTP ${svar.status}`);
  return svar.json();
}

// A whole, sane edition or nothing: half a forecast would rank the
// market wrong without anyone noticing.
export function kontrollera(rader) {
  if (!Array.isArray(rader) || rader.length < MIN_RADER) {
    throw new Error(`yrkesbarometern: ${Array.isArray(rader) ? rader.length : 'inga'} rader`);
  }
  const omgångar = new Set(rader.map((r) => r.omgang));
  const [omgång] = omgångar;
  if (omgångar.size !== 1 || !/^\d{4}-[12]$/.test(omgång || '')) throw new Error('yrkesbarometern: oklar omgång');
  for (const r of rader) {
    if (!r.yb_concept_id || !r.yb_yrke || !/^\d{2}$/.test(r.lan || '')
      || (r.jobbmojligheter != null && !JOBB.includes(r.jobbmojligheter))) {
      throw new Error(`yrkesbarometern: oväntad rad ${JSON.stringify(r).slice(0, 120)}`);
    }
  }
  return omgång;
}

const finns = async (tabell, omgång) => (await pool.query(
  `SELECT 1 FROM ${tabell} WHERE omgang = $1 LIMIT 1`, [omgång])).rowCount > 0;

async function sparaOmgång(rader) {
  // one row per occupation and county; the file repeats it per SSYK group
  const unika = new Map();
  for (const r of rader) unika.set(`${r.yb_concept_id}|${r.lan}`, r);
  const u = [...unika.values()];
  const kol = (f) => u.map(f);
  await pool.query(
    `INSERT INTO yrkesprognos (omgang, yb_id, lan, yrke, yrkesomrade, jobbmojligheter, rekrytering, prognos, text_jobb)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
     ON CONFLICT DO NOTHING`,
    [kol((r) => r.omgang), kol((r) => r.yb_concept_id), kol((r) => r.lan), kol((r) => r.yb_yrke),
      kol((r) => r.yrkesomrade ?? null), kol((r) => r.jobbmojligheter ?? null),
      kol((r) => r.rekryteringssituation ?? null), kol((r) => r.prognos ?? null),
      kol((r) => r.text_jobbmojligheter ?? null)]);
  return u.length;
}

async function sparaRelationer(omgång, fil) {
  const rel = (fil?.relationer || []).filter((r) => r.concept_id && r.yb_id);
  if (rel.length < 100) throw new Error(`relationsfilen: ${rel.length} rader`);
  await pool.query(
    `INSERT INTO yrkesprognos_yrke (omgang, concept_id, yb_id)
     SELECT $1, * FROM unnest($2::text[], $3::text[]) ON CONFLICT DO NOTHING`,
    [omgång, rel.map((r) => r.concept_id), rel.map((r) => String(r.yb_id).replace(/^yb_/, ''))]);
  return rel.length;
}

// The janitor's call: load what is new, leave what is there.
export async function hämtaYrkesbarometer({ hämta = fetch } = {}) {
  const nu = await läsJson(hämta, `${YB_BAS}/yrkesbarometer.json`);
  const omgång = kontrollera(nu);
  const r = { omgång, nya: [] };
  if (!(await finns('yrkesprognos', omgång))) {
    await sparaOmgång(nu);
    r.nya.push(omgång);
  }
  if (!(await finns('yrkesprognos_yrke', omgång))) {
    r.relationer = await sparaRelationer(omgång, await läsJson(hämta, `${YB_BAS}/yrkesbarometer_relationer.json`));
  }
  // the edition before, for "better or worse than last time"
  const förra = föregåendeOmgång(omgång);
  if (!(await finns('yrkesprognos', förra))) {
    try {
      const f = await läsJson(hämta, `${YB_BAS}/historiska/yrkesbarometer_${förra}.json`);
      if (kontrollera(f) === förra) {
        await sparaOmgång(f);
        r.nya.push(förra);
      }
    } catch (err) {
      r.förraFel = err.message.slice(0, 120);
    }
  }
  return r;
}

// ---- reading ----
const RANG = { små: 1, medelstora: 2, stora: 3 };

// Per occupation: the county's own assessment where AF made one, the
// national one otherwise — for the latest edition and the one before.
// $1 = county code ('00' for all of Sweden).
const BEDÖMNING = `
  nu AS (SELECT max(omgang) AS o FROM yrkesprognos),
  förra AS (SELECT max(omgang) AS o FROM yrkesprognos WHERE omgang < (SELECT o FROM nu)),
  rel AS (SELECT concept_id, yb_id FROM yrkesprognos_yrke
          WHERE omgang = (SELECT max(omgang) FROM yrkesprognos_yrke)),
  p AS (SELECT DISTINCT ON (yb_id) yb_id, yrke, yrkesomrade, jobbmojligheter, rekrytering, prognos, text_jobb, lan
        FROM yrkesprognos WHERE omgang = (SELECT o FROM nu) AND lan IN ($1, '00') AND jobbmojligheter IS NOT NULL
        ORDER BY yb_id, (lan = $1) DESC),
  f AS (SELECT DISTINCT ON (yb_id) yb_id, jobbmojligheter
        FROM yrkesprognos WHERE omgang = (SELECT o FROM förra) AND lan IN ($1, '00') AND jobbmojligheter IS NOT NULL
        ORDER BY yb_id, (lan = $1) DESC)`;
const ÖPPEN_ANNONS = `a.source = 'platsbanken' AND a.removed_at IS NULL
  AND (a.deadline IS NULL OR a.deadline >= current_date)`;

const lanFör = async (regionId) => (regionId
  ? (await pool.query(`SELECT lan FROM lan_region WHERE region_concept_id = $1`, [regionId])).rows[0]?.lan
  : null) || '00';

const ändring = (nu, förra) => {
  if (!förra || !nu || RANG[nu] === RANG[förra]) return null;
  return RANG[nu] > RANG[förra] ? 'bättre' : 'sämre';
};
const rad = (r) => ({
  yb_id: r.yb_id,
  yrke: r.yrke,
  yrkesomrade: r.yrkesomrade,
  jobbmojligheter: r.jobbmojligheter,
  rekrytering: r.rekrytering,
  prognos: r.prognos,
  text: r.text_jobb,
  lokal: r.lan !== '00',
  oppna: r.oppna,
  andring: ändring(r.jobbmojligheter, r.forra),
});

// ------------------------------------------------------------
// Marknaden: best and worst placed occupations in a region (or Sweden).
// ------------------------------------------------------------
export async function yrkesläge({ regionId = null, antal = 5 } = {}) {
  const lan = await lanFör(regionId);
  const { rows } = await pool.query(
    `WITH ${BEDÖMNING},
     annonser AS (
       SELECT rel.yb_id, count(*)::int AS oppna
       FROM ads a JOIN rel ON rel.concept_id = a.raw->'occupation'->>'concept_id'
       WHERE ${ÖPPEN_ANNONS} AND ($2::text IS NULL OR a.raw->'workplace_address'->>'region_concept_id' = $2)
       GROUP BY 1)
     SELECT p.*, COALESCE(an.oppna, 0) AS oppna, f.jobbmojligheter AS forra, (SELECT o FROM nu) AS omgang
     FROM p LEFT JOIN annonser an USING (yb_id) LEFT JOIN f USING (yb_id)
     ORDER BY COALESCE(an.oppna, 0) DESC, p.yrke`,
    [lan, regionId]);
  if (!rows.length) return null;
  return {
    omgang: rows[0].omgang,
    lan,
    bast: rows.filter((r) => r.jobbmojligheter === 'stora').slice(0, antal).map(rad),
    samst: rows.filter((r) => r.jobbmojligheter === 'små').slice(0, antal).map(rad),
    antal: { stora: rows.filter((r) => r.jobbmojligheter === 'stora').length,
      sma: rows.filter((r) => r.jobbmojligheter === 'små').length, alla: rows.length },
  };
}

// ------------------------------------------------------------
// Sökning: the market for what one search finds — its three most common
// occupations, in the county most of its ads are in (if most are in one;
// all of Sweden otherwise).
// ------------------------------------------------------------
export const EN_REGION = 0.6;

export async function sökläge(searchId) {
  const { rows: [s] } = await pool.query(
    `WITH r AS (
       SELECT a.raw->'workplace_address'->>'region_concept_id' AS region_id
       FROM match_results m JOIN ads a ON a.id = m.ad_id
       WHERE m.search_id = $1 AND ${ÖPPEN_ANNONS}),
     störst AS (SELECT region_id, count(*)::int AS n FROM r GROUP BY 1 ORDER BY 2 DESC LIMIT 1)
     SELECT (SELECT count(*) FROM r)::int AS oppna, störst.region_id, störst.n AS i_regionen
     FROM (SELECT 1) x LEFT JOIN störst ON true`, [searchId]);
  if (!s?.oppna) return null;
  const regionId = s.i_regionen / s.oppna >= EN_REGION ? s.region_id : null;
  const lan = await lanFör(regionId);
  const { rows } = await pool.query(
    `WITH ${BEDÖMNING},
     träffar AS (
       SELECT rel.yb_id, count(*)::int AS oppna
       FROM match_results m JOIN ads a ON a.id = m.ad_id
       JOIN rel ON rel.concept_id = a.raw->'occupation'->>'concept_id'
       WHERE m.search_id = $2 AND ${ÖPPEN_ANNONS}
       GROUP BY 1),
     -- the market for those occupations in the county, not what the
     -- search's own filters let through (that is the result list's number)
     marknad AS (
       SELECT rel.yb_id, count(*)::int AS oppna,
              count(*) FILTER (WHERE a.published_at > now() - interval '7 days')::int AS nya_7
       FROM ads a JOIN rel ON rel.concept_id = a.raw->'occupation'->>'concept_id'
       WHERE ${ÖPPEN_ANNONS} AND ($3::text IS NULL OR a.raw->'workplace_address'->>'region_concept_id' = $3)
       GROUP BY 1)
     SELECT p.*, COALESCE(mk.oppna, 0) AS oppna, COALESCE(mk.nya_7, 0) AS nya_7,
            f.jobbmojligheter AS forra, (SELECT o FROM nu) AS omgang
     FROM träffar t JOIN p USING (yb_id) LEFT JOIN f USING (yb_id) LEFT JOIN marknad mk USING (yb_id)
     ORDER BY t.oppna DESC, p.yrke LIMIT 3`,
    [lan, searchId, regionId]);
  if (!rows.length) return null;
  const { rows: [reg] } = await pool.query(`SELECT namn FROM lan_region WHERE lan = $1`, [lan]);
  return {
    omgang: rows[0].omgang,
    region: reg?.namn || null,
    yrken: rows.map((r) => ({ ...rad(r), nya_7: r.nya_7 })),
  };
}
