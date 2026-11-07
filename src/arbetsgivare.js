import { pool } from './db.js';

// ------------------------------------------------------------
// What kind of employer stands behind an ad — for the Marknaden tab's
// view per employer type, where "who answers" differs most.
//
//   foretag      everyone else
//   offentlig    general government: state, regions, municipalities
//   bemanning    SNI 78.2/78.3 — hires staff out to clients; the agency
//                is the employer and the one who answers
//   rekrytering  SNI 78.1 — recruits on behalf of a client, who then
//                employs; behaves more like the employer it hires for
//
// The answer comes from SCB's company register by organisation number
// (free since June 2025; terms: use and spread freely, name the source
// and that we processed it). A name guess fills in until SCB has
// answered — before the key is set, for numbers SCB does not know, or
// while SCB is down.
//
// Sole traders are skipped altogether: their organisation number is
// the owner's personal identity number. They are not looked up, not
// stored, and count as foretag (src/marknad.js).
// ------------------------------------------------------------

export const SCB_BAS = 'https://apiafr.scb.se/v1';
export const SCB_MELLANRUM_MS = 250;   // 4 calls a second; the terms allow 5
export const SCB_PER_VARV = 3000;      // about 12.5 minutes of a janitor round
const OMFRÅGA_SAKNAS = '30 days';
const OMFRÅGA_HITTAD = '180 days';

// A legal entity's number has 20 or more in the "month" digits; a sole
// trader's is a birth date.
export const ärJuridisk = (orgnr) => /^[0-9]{10}$/.test(orgnr || '') && orgnr[2] >= '2';

// ---- from SCB's answer ----
// sektor: institutional sector, 13xxxx = general government.
// jurform: 81 state, 82 municipality, 83 municipal federation,
// 84 region, 85 social insurance, 87 public corporation, 89 regional
// state authority — the fallback when sektor is missing.
const OFFENTLIG_JURFORM = new Set(['81', '82', '83', '84', '85', '87', '89']);

// Staffing or recruitment counts even when it is not the main industry,
// if it is a real share of the business: Jobandtalent is 62 % "head
// office" (70100) and 38 % recruitment (78100), and a filter for direct
// employers must still keep it out.
export const MELLANHAND_ANDEL = 25;
const siffror = (g) => String(g?.naringsgren || '').replace(/\D/g, '');
const mellanTyp = (sni) => (sni.startsWith('781') ? 'rekrytering'
  : sni.startsWith('782') || sni.startsWith('783') ? 'bemanning' : null);

export function typFrånScb(je) {
  const sektor = String(je?.sektor || '');
  const jurform = String(je?.jurform || '');
  const grenar = [...(je?.naringsgrenar || [])]
    .sort((a, b) => (a.rangordning ?? 99) - (b.rangordning ?? 99));
  const sni = siffror(grenar[0]);
  let typ = 'foretag';
  if (sektor.startsWith('13') || (!sektor && OFFENTLIG_JURFORM.has(jurform))) {
    typ = 'offentlig';
  } else if (mellanTyp(sni)) {
    typ = mellanTyp(sni);
  } else {
    const bi = grenar.find((g) => mellanTyp(siffror(g)) && (g.andelProcent ?? 0) >= MELLANHAND_ANDEL);
    if (bi) typ = mellanTyp(siffror(bi));
  }
  return {
    typ, sni: sni || null, jurform: jurform || null, sektor: sektor || null,
    // every code with its share, so the type can be recomputed later
    // (omklassaLagrade) without asking SCB again
    naringsgrenar: grenar.map((g) => ({ sni: siffror(g), andel: g.andelProcent ?? null })),
  };
}

// ---- from the name, until SCB answers ----
const BEMANNING = /bemanning|staffing|personaluthyrning|uthyrning|jobandtalent|academic work|manpower|randstad|adecco|poolia|dfind|experis|framtiden|wise professionals|jefferson wells|lernia|proffice|uniflex|studentconsulting|tempoteam/i;
const REKRYTERING = /rekryter|recruit|headhunt|executive search|talent acquisition/i;
const OFFENTLIG = /kommun\b|kommunen|\bregion\s|regionen\b|landsting|myndighet|universitet|högskola|statens|försäkringskassan|arbetsförmedlingen|polismyndigheten|polisen|trafikverket|skatteverket|kriminalvården|migrationsverket|försvarsmakten|länsstyrelsen/i;

export function typFrånNamn(namn = '') {
  // "Rekrytering & Bemanning" hires out too — staffing wins
  if (BEMANNING.test(namn)) return 'bemanning';
  if (REKRYTERING.test(namn)) return 'rekrytering';
  if (OFFENTLIG.test(namn)) return 'offentlig';
  return 'foretag';
}

// ---- SCB ----
const vänta = (ms) => new Promise((r) => { setTimeout(r, ms); });

// One lookup. Returns { status: 'hittad', je } | { status: 'saknas' };
// throws on anything that should end this round (bad key, SCB down).
// SCB's path takes a "PeOrgNr": tried as 16 + the number first (SCB's
// form for legal entities), then as the bare number, and the form that
// answers is kept for the rest of the process.
let peForm = null;
async function slåUpp(orgnr, { nyckel, hämta, takt }) {
  const former = peForm ? [peForm] : ['16', ''];
  for (const prefix of former) {
    for (let försök = 0; ; försök += 1) {
      await takt();
      const svar = await hämta(`${SCB_BAS}/juridiskaenheter/${prefix}${orgnr}/full`, {
        headers: { 'X-API-Key': nyckel, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (svar.status === 429 && försök < 3) {
        const sek = Math.min(Number(svar.headers.get('retry-after')) || 2, 60);
        await vänta(sek * 1000);
        continue;
      }
      if (svar.ok) {
        peForm = prefix;
        return { status: 'hittad', je: await svar.json() };
      }
      if (svar.status === 404 || svar.status === 400) break;   // try the other form, then "saknas"
      const fel = new Error(`SCB svarade ${svar.status}`);
      fel.status = svar.status;
      throw fel;
    }
  }
  return { status: 'saknas' };
}

// ------------------------------------------------------------
// The janitor's round: every organisation number in the pool gets a
// type. New ones are named at once (by name, or by SCB when the key is
// set); with a key, name guesses are replaced by SCB's answer, numbers
// SCB did not know are asked again after a month, and known ones are
// re-read twice a year. `bara` limits the round to some numbers (the
// proof uses it).
// ------------------------------------------------------------
export async function klassaArbetsgivare({
  nyckel = process.env.SCB_API_KEY, hämta = fetch, max = SCB_PER_VARV, bara = null,
} = {}) {
  const medScb = Boolean(nyckel);
  const { rows: kandidater } = await pool.query(
    `WITH a AS (
       SELECT raw->'employer'->>'organization_number' AS orgnr, employer
       FROM ads WHERE source = 'platsbanken')
     SELECT a.orgnr, mode() WITHIN GROUP (ORDER BY a.employer) AS namn, count(*) AS annonser,
            g.orgnr IS NOT NULL AS finns
     FROM a LEFT JOIN arbetsgivare g USING (orgnr)
     WHERE a.orgnr ~ '^[0-9]{10}$' AND substr(a.orgnr, 3, 1) >= '2'
       AND ($2::text[] IS NULL OR a.orgnr = ANY($2))
       AND (g.orgnr IS NULL OR ($1 AND (
             g.scb_status IS NULL
          OR (g.scb_status = 'saknas' AND g.scb_forsokt < now() - interval '${OMFRÅGA_SAKNAS}')
          OR (g.scb_status = 'hittad' AND g.scb_forsokt < now() - interval '${OMFRÅGA_HITTAD}'))))
     GROUP BY a.orgnr, g.orgnr
     ORDER BY count(*) DESC`,
    [medScb, bara]);

  let senast = 0;
  const takt = async () => {
    const kvar = senast + SCB_MELLANRUM_MS - Date.now();
    if (kvar > 0) await vänta(kvar);
    senast = Date.now();
  };

  const namnRader = [];
  const r = { kandidater: kandidater.length, scb: 0, saknas: 0, namn: 0, stopp: null };
  let frågor = 0;
  for (const k of kandidater) {
    if (medScb && !r.stopp && frågor < max) {
      frågor += 1;
      try {
        const svar = await slåUpp(k.orgnr, { nyckel, hämta, takt });
        if (svar.status === 'hittad') {
          const t = typFrånScb(svar.je);
          await spara({ orgnr: k.orgnr, ...t, kalla: 'scb', scb_status: 'hittad' });
          r.scb += 1;
        } else {
          await spara({ orgnr: k.orgnr, typ: typFrånNamn(k.namn), kalla: 'namn', scb_status: 'saknas' });
          r.saknas += 1;
        }
        continue;
      } catch (err) {
        // A bad key, SCB's nightly window, a network failure: stop asking
        // this round, name the new numbers, and ask again next round.
        r.stopp = err.status ? `SCB ${err.status}` : err.message.slice(0, 80);
      }
    }
    if (!k.finns) namnRader.push({ orgnr: k.orgnr, typ: typFrånNamn(k.namn) });
  }

  for (let i = 0; i < namnRader.length; i += 1000) {
    const del = namnRader.slice(i, i + 1000);
    await pool.query(
      `INSERT INTO arbetsgivare (orgnr, typ, kalla)
       SELECT * , 'namn' FROM unnest($1::text[], $2::text[])
       ON CONFLICT (orgnr) DO NOTHING`,
      [del.map((d) => d.orgnr), del.map((d) => d.typ)]);
  }
  r.namn = namnRader.length;
  return r;
}

async function spara(g) {
  await pool.query(
    `INSERT INTO arbetsgivare (orgnr, typ, kalla, sni, jurform, sektor, naringsgrenar, scb_status, scb_forsokt, uppdaterad)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
     ON CONFLICT (orgnr) DO UPDATE SET typ = EXCLUDED.typ, kalla = EXCLUDED.kalla, sni = EXCLUDED.sni,
       jurform = EXCLUDED.jurform, sektor = EXCLUDED.sektor, naringsgrenar = EXCLUDED.naringsgrenar,
       scb_status = EXCLUDED.scb_status, scb_forsokt = now(), uppdaterad = now()`,
    [g.orgnr, g.typ, g.kalla, g.sni ?? null, g.jurform ?? null, g.sektor ?? null,
      g.naringsgrenar ? JSON.stringify(g.naringsgrenar) : null, g.scb_status]);
}

// ------------------------------------------------------------
// A changed rule, applied to what is already known: every employer SCB
// answered is typed again from its stored codes — no call to SCB. The
// janitor runs this before asking SCB about anything new, so a new rule
// takes effect on the first round after it is deployed.
// ------------------------------------------------------------
export async function omklassaLagrade() {
  const { rows } = await pool.query(
    `SELECT orgnr, typ, sektor, jurform, naringsgrenar FROM arbetsgivare
     WHERE kalla = 'scb' AND naringsgrenar IS NOT NULL`);
  const ändrade = [];
  for (const r of rows) {
    const { typ } = typFrånScb({
      sektor: r.sektor, jurform: r.jurform,
      naringsgrenar: r.naringsgrenar.map((g, i) => ({ rangordning: i + 1, naringsgren: g.sni, andelProcent: g.andel })),
    });
    if (typ !== r.typ) ändrade.push({ orgnr: r.orgnr, typ });
  }
  if (ändrade.length) {
    await pool.query(
      `UPDATE arbetsgivare g SET typ = n.typ, uppdaterad = now()
       FROM unnest($1::text[], $2::text[]) AS n(orgnr, typ) WHERE g.orgnr = n.orgnr`,
      [ändrade.map((x) => x.orgnr), ändrade.map((x) => x.typ)]);
  }
  return { lästa: rows.length, ändrade: ändrade.length };
}

// ------------------------------------------------------------
// Limiting a search or campaign to some employer types — "only the
// employer itself, no staffing agency in between". SQL over ad alias a.
//
// An ad whose type is unknown (no organisation number, or not yet
// classified) is kept: hiding a job for want of a number is worse than
// showing it, and the campaign's own score still has to clear.
// A sole trader is a company (their number is never looked up).
// ------------------------------------------------------------
export const typAv = (a) => `COALESCE(
  (SELECT g.typ FROM arbetsgivare g WHERE g.orgnr = ${a}.raw->'employer'->>'organization_number'),
  CASE WHEN ${a}.raw->'employer'->>'organization_number' ~ '^[0-9]{10}$'
        AND substr(${a}.raw->'employer'->>'organization_number', 3, 1) < '2' THEN 'foretag' END,
  'okand')`;
export const typTillåten = (a, typerSql) => `(${typAv(a)} = 'okand' OR ${typAv(a)} = ANY(${typerSql}))`;

// for the proof: forget which PeOrgNr form SCB answered to
export const glömPeForm = () => { peForm = null; };
