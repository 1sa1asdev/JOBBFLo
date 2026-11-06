import { pool } from './db.js';

// ------------------------------------------------------------
// The shared market: what the whole pool says about who is hiring,
// and what the app's users together have seen of it.
//
// Two kinds of number, with different rules:
//
//   From the ads    Platsbanken's own ads, the same for everyone. Shown
//                   as they are. A user's pasted ads (source 'manual')
//                   are theirs alone and never counted.
//   From the users  applications sent and replies received. Shown only
//                   when enough different users stand behind a number
//                   that it cannot be traced back to one of them — and
//                   for reply rates, only when the sample says something
//                   (CLAUDE.md: features that need data are gated, not
//                   shown early with invented precision).
//
// History is written down daily (marknad_dag, byggMarknad below):
// closed ads are deleted seven days after closing, so the pool alone
// cannot say what last month looked like.
// ------------------------------------------------------------
export const MIN_ANVÄNDARE = 5;     // users behind any number built from their activity
export const MIN_SVAR = 20;         // sent applications behind a reply rate
export const TREND_DAGAR = 28;      // recorded days before a trend is shown
export const FÖNSTER = 7;           // days recomputed on every run (and the pool's grace period)
export const SVARSTID = 14;         // days a letter gets to be answered before it counts towards a reply rate

// The applications a reply rate is a share of: letters sent through the
// app (a reply to an application made on the employer's site never
// reaches the app's inbox), that arrived (not bounced) and were not
// taken back, sent long enough ago to have been answered — a letter
// from yesterday is not "unanswered" yet — and within the last 90 days.
const SVARBAR = `sent_by <> 'external' AND status NOT IN ('undeliverable', 'withdrawn')
  AND sent_at > now() - interval '90 days' AND sent_at <= now() - interval '${SVARSTID} days'`;

const DAG = (kolumn) => `(${kolumn} AT TIME ZONE 'Europe/Stockholm')::date`;
const IDAG = `(now() AT TIME ZONE 'Europe/Stockholm')::date`;
const PLATSER = `CASE WHEN jsonb_typeof(raw->'number_of_vacancies') = 'number'
  THEN GREATEST((raw->>'number_of_vacancies')::int, 1) ELSE 1 END`;
// Platsbanken's ads only, keyed on concept_id (CLAUDE.md invariant 6)
const ANNONSER = `
  SELECT COALESCE(raw->'occupation_field'->>'concept_id', 'okänt') AS falt_id,
         COALESCE(raw->'occupation_field'->>'label', 'Okänt yrkesområde') AS falt,
         COALESCE(raw->'workplace_address'->>'region_concept_id', 'okänt') AS region_id,
         COALESCE(raw->'workplace_address'->>'region', region, 'Okänd region') AS region,
         ${DAG('published_at')} AS pub, ${DAG('removed_at')} AS stängd, deadline,
         ${PLATSER} AS platser
  FROM ads WHERE source = 'platsbanken' AND published_at IS NOT NULL`;
const ÖPPEN = (dag) => `pub <= ${dag} AND (stängd IS NULL OR stängd > ${dag})
  AND (deadline IS NULL OR deadline >= ${dag})`;

// ------------------------------------------------------------
// The last FÖNSTER days, recomputed and written down. Within that
// window the pool still holds every ad that touched it (nothing closed
// less than seven days ago has been deleted), so the counts are whole;
// older days are left as they were written.
// ------------------------------------------------------------
export async function byggMarknad({ dagar = FÖNSTER } = {}) {
  const klient = await pool.connect();
  try {
    await klient.query('BEGIN');
    await klient.query(`DELETE FROM marknad_dag WHERE dag >= ${IDAG} - $1::int`, [dagar]);
    const { rowCount } = await klient.query(
      `WITH dagar AS (SELECT generate_series(${IDAG} - $1::int, ${IDAG}, '1 day')::date AS dag),
            a AS (${ANNONSER})
       INSERT INTO marknad_dag (dag, falt_id, falt, region_id, region, nya, platser, stangda, oppna)
       SELECT d.dag, a.falt_id, mode() WITHIN GROUP (ORDER BY a.falt), a.region_id, mode() WITHIN GROUP (ORDER BY a.region),
              count(*) FILTER (WHERE a.pub = d.dag),
              COALESCE(sum(a.platser) FILTER (WHERE a.pub = d.dag), 0),
              count(*) FILTER (WHERE a.stängd = d.dag),
              count(*) FILTER (WHERE ${ÖPPEN('d.dag')})
       FROM dagar d
       JOIN a ON a.pub <= d.dag AND (a.stängd IS NULL OR a.stängd >= d.dag)
       GROUP BY d.dag, a.falt_id, a.region_id`, [dagar]);
    await klient.query('COMMIT');
    return { rader: rowCount };
  } catch (err) {
    await klient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    klient.release();
  }
}

// ------------------------------------------------------------
// The market right now, for the Marknaden tab: per occupation field,
// whole Sweden or one region. Region is a concept_id or null.
// ------------------------------------------------------------
export async function marknadsläge({ regionId = null } = {}) {
  const iRegion = regionId ? `AND region_id = $1` : '';
  const param = regionId ? [regionId] : [];

  const { rows: fält } = await pool.query(
    `WITH a AS (${ANNONSER})
     SELECT falt_id, mode() WITHIN GROUP (ORDER BY falt) AS falt,
       count(*) FILTER (WHERE ${ÖPPEN(IDAG)})::int AS oppna,
       count(*) FILTER (WHERE pub > ${IDAG} - 7)::int AS nya_7,
       COALESCE(sum(platser) FILTER (WHERE ${ÖPPEN(IDAG)}), 0)::int AS platser,
       count(*) FILTER (WHERE stängd > ${IDAG} - 7)::int AS stangda_7,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY stängd - pub)
         FILTER (WHERE stängd > ${IDAG} - 7) AS median_dagar
     FROM a WHERE true ${iRegion}
     GROUP BY falt_id
     HAVING count(*) FILTER (WHERE ${ÖPPEN(IDAG)}) > 0 OR count(*) FILTER (WHERE pub > ${IDAG} - 7) > 0
     ORDER BY nya_7 DESC, oppna DESC`, param);

  // Trends from what has been written down — only once there is enough of it.
  const { rows: [{ dagar }] } = await pool.query(
    `SELECT count(DISTINCT dag)::int AS dagar FROM marknad_dag`);
  const trend = new Map();
  if (dagar >= TREND_DAGAR) {
    const { rows } = await pool.query(
      `SELECT falt_id,
         sum(nya) FILTER (WHERE dag > ${IDAG} - 14)::int AS nu,
         sum(nya) FILTER (WHERE dag <= ${IDAG} - 14 AND dag > ${IDAG} - 28)::int AS förut
       FROM marknad_dag WHERE dag > ${IDAG} - 28 ${iRegion}
       GROUP BY falt_id`, param);
    for (const r of rows) {
      if (r.förut > 0) trend.set(r.falt_id, Math.round(((r.nu - r.förut) / r.förut) * 100));
    }
  }

  // What the app's users did, by field — behind the thresholds above.
  const { rows: användning } = await pool.query(
    `WITH a AS (
       SELECT COALESCE(ads.raw->'occupation_field'->>'concept_id', 'okänt') AS falt_id,
              COALESCE(ads.raw->'workplace_address'->>'region_concept_id', 'okänt') AS region_id,
              ap.profile_id, ap.status, ap.sent_at, ap.sent_by
       FROM applications ap JOIN ads ON ads.id = ap.ad_id
       WHERE ads.source = 'platsbanken' AND ap.sent_at IS NOT NULL)
     SELECT falt_id,
       count(*) FILTER (WHERE sent_at > now() - interval '30 days')::int AS sokta_30,
       count(DISTINCT profile_id) FILTER (WHERE sent_at > now() - interval '30 days')::int AS anv_30,
       count(*) FILTER (WHERE ${SVARBAR})::int AS skickade_90,
       count(DISTINCT profile_id) FILTER (WHERE ${SVARBAR})::int AS anv_90,
       -- each application counts once, at the furthest it got
       count(*) FILTER (WHERE ${SVARBAR} AND status IN ('replied', 'interview', 'rejected'))::int AS svar_90,
       count(*) FILTER (WHERE ${SVARBAR} AND status = 'interview')::int AS intervju_90,
       count(*) FILTER (WHERE ${SVARBAR} AND status = 'rejected')::int AS nej_90
     FROM a WHERE true ${iRegion}
     GROUP BY falt_id`, param);
  const perFält = new Map(användning.map((r) => [r.falt_id, r]));

  const rader = fält.map((f) => {
    const u = perFält.get(f.falt_id);
    const svarOk = u && u.skickade_90 >= MIN_SVAR && u.anv_90 >= MIN_ANVÄNDARE;
    return {
      falt_id: f.falt_id,
      falt: f.falt,
      oppna: f.oppna,
      nya_7: f.nya_7,
      platser: f.platser,
      // a median of three closings is an anecdote
      median_dagar: f.stangda_7 >= MIN_ANVÄNDARE && f.median_dagar != null ? Math.round(Number(f.median_dagar)) : null,
      trend: trend.has(f.falt_id) ? trend.get(f.falt_id) : null,
      sokta_30: u && u.anv_30 >= MIN_ANVÄNDARE ? u.sokta_30 : null,
      svar: svarOk ? {
        andel: Math.round((u.svar_90 / u.skickade_90) * 100),
        intervju: Math.round((u.intervju_90 / u.skickade_90) * 100),
        nej: Math.round((u.nej_90 / u.skickade_90) * 100),
        av: u.skickade_90,
      } : null,
    };
  });

  const { rows: regioner } = await pool.query(
    `WITH a AS (${ANNONSER})
     SELECT region_id, mode() WITHIN GROUP (ORDER BY region) AS region, count(*)::int AS oppna
     FROM a WHERE ${ÖPPEN(IDAG)} AND region_id <> 'okänt'
     GROUP BY region_id ORDER BY 2`);

  return {
    rader,
    totalt: {
      oppna: rader.reduce((s, r) => s + r.oppna, 0),
      nya_7: rader.reduce((s, r) => s + r.nya_7, 0),
      platser: rader.reduce((s, r) => s + r.platser, 0),
    },
    regioner,
    historik: { dagar, trendFrån: TREND_DAGAR },
    gränser: { användare: MIN_ANVÄNDARE, svar: MIN_SVAR, svarstid: SVARSTID },
  };
}

// How many of the app's users have applied to one ad — through a letter
// sent from the app, or on the employer's site and confirmed with
// "Jag har sökt". null below the threshold: "1 user applied" to a small
// employer is close to naming them.
export async function antalSökande(adId) {
  const { rows: [r] } = await pool.query(
    `SELECT count(DISTINCT profile_id)::int AS n FROM applications
     WHERE ad_id = $1 AND sent_at IS NOT NULL`, [adId]);
  return r.n >= MIN_ANVÄNDARE ? r.n : null;
}
