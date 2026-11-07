// Proves the employer types right, and that SCB is used as its terms say.
//
//   node scripts/prove-arbetsgivare.js
//
//   1. SCB's answer decides: the primary SNI code (78.2 hires out, 78.1
//      recruits), and general government (sector 13) before either
//   2. without a key every number is named from the employer name, and
//      SCB is never called
//   3. with a key: at most four calls a second, the key in X-API-Key, a
//      429 waited out, a 404 named from the name and asked again in a
//      month, and nothing asked twice in one round
//   4. SCB down (503): the round stops after one call and keeps what it had
//   5. only the classification is stored — not the name, phone or e-mail
//      SCB sends — and the key is stored nowhere
//   6. a sole trader's number (a personal identity number) is never sent
//      to SCB and never stored; the table refuses it
//   7. the market view counts per type, and says how much SCB stands behind
//   8. no code the browser loads knows the key or SCB's address
//  10. every industry code is stored with its share, and a changed rule
//      is applied from those — without asking SCB again
//   9. a search or campaign limited to some employer types finds only
//      those (plus ads of unknown type); all types or none is no filter
//
// Against a fake SCB, on throwaway ads in a region of their own.
import 'dotenv/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../src/db.js';
import { klassaArbetsgivare, typFrånScb, typFrånNamn, glömPeForm, SCB_MELLANRUM_MS, omklassaLagrade } from '../src/arbetsgivare.js';
import { marknadsläge } from '../src/marknad.js';
import { countLocal } from '../src/localsearch.js';
import { rensaTyper, DIREKT } from '../lib/arbetsgivartyp.js';

const RUN = `${Date.now()}`;
const REGION = `bevis-reg-ag-${RUN}`;
const NYCKEL = `bevisnyckel-${RUN}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};

// "0099…": a group digit of 0 is never a real organisation number
const A = '0099100001', B = '0099100002', C = '0099100003', D = '0099100004', E = '0099100005';
const ENSKILD = '0012345678';   // third digit 1: a birth date, not a company
const GAMMAL = '0099100009';   // read under an older rule (check 10)
const ALLA = [A, B, C, D, E, ENSKILD];
const NAMN = { [A]: 'Bevis Ett AB', [B]: 'Bevis Två AB', [C]: 'Bevis Tre AB', [D]: 'Bevis Bemanning AB', [E]: 'Bevis Fem AB', [ENSKILD]: 'Sven Bevisson Bemanning' };

const adIds = [];
let profilId = null;
const annons = async (n, orgnr) => {
  const raw = {
    id: `${RUN}-${n}`, headline: 'Bevis',
    occupation_field: { concept_id: `bevis-falt-${RUN}`, label: 'Bevisområdet' },
    workplace_address: { region: 'Bevisregionen', region_concept_id: REGION },
    ...(orgnr ? { employer: { organization_number: orgnr } } : {}),
  };
  const { rows: [a] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description, raw, region, published_at)
     VALUES ('platsbanken', $1, $1, 'Bevis', $2, 'x', $3, 'Bevisregionen', now() - interval '3 days') RETURNING id`,
    [`prove-arbetsgivare-${RUN}-${n}`, NAMN[orgnr] || 'Utan nummer AB', JSON.stringify(raw)]);
  adIds.push(a.id);
};

// ---- a fake SCB ----
const HEMLIGT = { namn: 'Hemliga Bolaget AB', tel: '08-HEMLIGT', epost: 'hemlig@bevis.invalid', postAdress: { gatuadress: 'Hemliga gatan 1' } };
const SVAR = {
  [A]: { ...HEMLIGT, sektor: '111000', jurform: '49',
    naringsgrenar: [{ rangordning: 2, naringsgren: '47110' }, { rangordning: 1, naringsgren: '78200' }] },
  [B]: { sektor: '111000', jurform: '49', naringsgrenar: [{ rangordning: 1, naringsgren: '78100' }] },
  [C]: { sektor: '131311', jurform: '82', naringsgrenar: [{ rangordning: 1, naringsgren: '78200' }] },
  [E]: { sektor: '111000', jurform: '49', naringsgrenar: [{ rangordning: 1, naringsgren: '62010' }] },
};
let anrop = [];
const allaAnrop = [];   // every call of the run, for check 6
let läge = 'normal';
const hämta = async (url, opts) => {
  const nr = /juridiskaenheter\/(\d+)\/full$/.exec(url)?.[1] || '';
  anrop.push({ nr, tid: Date.now(), nyckel: opts?.headers?.['X-API-Key'] });
  allaAnrop.push(nr);
  if (läge === 'nere') return new Response('', { status: 503 });
  const orgnr = nr.startsWith('16') ? nr.slice(2) : null;   // this fake answers only to SCB's 16-form
  if (orgnr === B && !anrop.slice(0, -1).some((x) => x.nr === nr)) {
    return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
  }
  if (!orgnr || !SVAR[orgnr]) return new Response('', { status: 404 });
  return new Response(JSON.stringify(SVAR[orgnr]), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const rad = async (orgnr) => (await pool.query(`SELECT * FROM arbetsgivare WHERE orgnr = $1`, [orgnr])).rows[0];

try {
  // ---- 1 ----
  kolla('1. huvudnäringsgrenen avgör (rangordning 1), 78.2 är bemanning', typFrånScb(SVAR[A]).typ === 'bemanning');
  kolla('1. 78.1 är rekrytering', typFrånScb(SVAR[B]).typ === 'rekrytering');
  kolla('1. offentlig sektor (13…) går före näringsgrenen', typFrånScb(SVAR[C]).typ === 'offentlig');
  kolla('1. utan sektor: kommun som juridisk form är offentlig', typFrånScb({ jurform: '82', naringsgrenar: [] }).typ === 'offentlig');
  kolla('1. allt annat är företag', typFrånScb(SVAR[E]).typ === 'foretag');
  kolla('1. bemanning som bisyssla räknas från en fjärdedel av verksamheten',
    typFrånScb({ sektor: '111000', naringsgrenar: [{ rangordning: 1, naringsgren: '70100', andelProcent: 62 },
      { rangordning: 2, naringsgren: '78100', andelProcent: 38 }] }).typ === 'rekrytering'
    && typFrånScb({ sektor: '111000', naringsgrenar: [{ rangordning: 1, naringsgren: '62010', andelProcent: 90 },
      { rangordning: 2, naringsgren: '78200', andelProcent: 10 }] }).typ === 'foretag');
  kolla('1. namn: "Rekrytering & Bemanning" hyr ut — bemanning', typFrånNamn('Kraftsam Rekrytering & Bemanning AB') === 'bemanning');
  kolla('1. namn: rekrytering, region, kommun, vanligt bolag',
    typFrånNamn('Schnell Rekrytering AB') === 'rekrytering' && typFrånNamn('REGION SKÅNE') === 'offentlig'
    && typFrånNamn('Västra Götalandsregionen') === 'offentlig' && typFrånNamn('Göteborgs kommun') === 'offentlig'
    && typFrånNamn('Kommunal') === 'foretag' && typFrånNamn('Volvo Car AB') === 'foretag');

  for (const [i, nr] of ALLA.entries()) await annons(i, nr);
  await annons(99, null);

  // ---- 2 ----
  const r0 = await klassaArbetsgivare({ nyckel: '', hämta, bara: ALLA });
  kolla('2. utan nyckel: SCB anropas inte', anrop.length === 0);
  kolla('2. utan nyckel: alla får en typ efter namnet', r0.namn === 5 && (await rad(D)).typ === 'bemanning'
    && (await rad(A)).kalla === 'namn', JSON.stringify(r0));

  // ---- 3 ----
  glömPeForm();
  const r1 = await klassaArbetsgivare({ nyckel: NYCKEL, hämta, bara: ALLA });
  const typer = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async (n) => [n, await rad(n)])));
  kolla('3. SCB:s svar ersätter namngissningen',
    typer[A].typ === 'bemanning' && typer[B].typ === 'rekrytering' && typer[C].typ === 'offentlig' && typer[E].typ === 'foretag'
    && [A, B, C, E].every((n) => typer[n].kalla === 'scb' && typer[n].scb_status === 'hittad'), JSON.stringify(r1));
  kolla('3. okänd för SCB (404): namnet gäller, frågas igen om en månad',
    typer[D].kalla === 'namn' && typer[D].scb_status === 'saknas' && typer[D].typ === 'bemanning');
  kolla('3. nyckeln skickas i X-API-Key', anrop.every((x) => x.nyckel === NYCKEL));
  kolla('10. alla näringsgrenar lagras, i rangordning, med andel',
    JSON.stringify(typer[A].naringsgrenar?.map((g) => g.sni)) === '["78200","47110"]', JSON.stringify(typer[A].naringsgrenar));
  const mellan = anrop.slice(1).map((x, i) => x.tid - anrop[i].tid);
  kolla('3. högst fyra anrop i sekunden', Math.min(...mellan) >= SCB_MELLANRUM_MS - 5, `minsta mellanrum ${Math.min(...mellan)} ms`);
  kolla('3. 429: väntar Retry-After och frågar igen', mellan.some((m) => m >= 990) && typer[B].kalla === 'scb');
  anrop = [];
  await klassaArbetsgivare({ nyckel: NYCKEL, hämta, bara: ALLA });
  kolla('3. nästa varv frågar inte om det som redan är besvarat', anrop.length === 0);

  // ---- 4 ----
  await pool.query(`UPDATE arbetsgivare SET scb_status = NULL WHERE orgnr = ANY($1)`, [[A, E]]);
  läge = 'nere';
  const r2 = await klassaArbetsgivare({ nyckel: NYCKEL, hämta, bara: ALLA });
  kolla('4. SCB nere: varvet slutar efter ett anrop', anrop.length === 1 && r2.stopp === 'SCB 503', JSON.stringify(r2));
  kolla('4. det som redan fanns står kvar', (await rad(A)).typ === 'bemanning' && (await rad(E)).typ === 'foretag');
  läge = 'normal';

  // ---- 5 ----
  const lagrat = JSON.stringify(await pool.query(`SELECT * FROM arbetsgivare WHERE orgnr = ANY($1)`, [ALLA]).then((x) => x.rows));
  const läckor = ['Hemliga', 'HEMLIGT', 'hemlig@', NYCKEL].filter((s) => lagrat.includes(s));
  kolla('5. bara klassningen lagras — inte namn, telefon, e-post eller nyckel', läckor.length === 0, läckor.join(', '));

  // ---- 6 ----
  kolla('6. enskild firma: aldrig skickad till SCB', allaAnrop.length > 0 && !allaAnrop.some((nr) => nr.includes(ENSKILD)));
  kolla('6. enskild firma: aldrig lagrad', !(await rad(ENSKILD)));
  const vägrad = await pool.query(`INSERT INTO arbetsgivare (orgnr, typ, kalla) VALUES ($1, 'foretag', 'namn')`, [ENSKILD])
    .then(() => false, () => true);
  kolla('6. tabellen vägrar ett personnummer', vägrad);

  // ---- 7 ----
  const m = (await marknadsläge({ regionId: REGION })).arbetsgivartyp;
  const per = Object.fromEntries(m.typer.map((t) => [t.typ, t.oppna]));
  kolla('7. marknaden räknar per typ (enskild firma som företag)',
    per.foretag === 2 && per.offentlig === 1 && per.bemanning === 2 && per.rekrytering === 1, JSON.stringify(per));
  kolla('7. annons utan nummer: okänd, inte gissad', m.okanda === 1);
  kolla('7. hur mycket SCB står bakom', m.fran_scb === 57, `${m.fran_scb} % (4 av 7)`);

  // ---- 10 ----
  await pool.query(
    `INSERT INTO arbetsgivare (orgnr, typ, kalla, sni, sektor, naringsgrenar, scb_status, scb_forsokt)
     VALUES ($1, 'foretag', 'scb', '70100', '111000', $2, 'hittad', now())`,
    [GAMMAL, JSON.stringify([{ sni: '70100', andel: 62 }, { sni: '78100', andel: 38 }])]);
  const anropFöre = allaAnrop.length;
  const om = await omklassaLagrade();
  kolla('10. en ändrad regel räknas om från lagrade koder — utan SCB',
    (await rad(GAMMAL)).typ === 'rekrytering' && allaAnrop.length === anropFöre && om.ändrade >= 1, JSON.stringify(om));
  const igen = await omklassaLagrade();
  kolla('10. att räkna om igen ändrar inget', !(await pool.query(
    `SELECT 1 FROM arbetsgivare WHERE orgnr = ANY($1) AND uppdaterad > now() - interval '1 second'`, [[GAMMAL]])).rowCount
    || igen.ändrade === 0, JSON.stringify(igen));

  // ---- 9 ----
  kolla('9. alla typer eller inga är inget filter', rensaTyper([]) === null
    && rensaTyper(['foretag', 'offentlig', 'bemanning', 'rekrytering']) === null
    && JSON.stringify(rensaTyper(['bemanning', 'påhittad'])) === '["bemanning"]');
  const { rows: [bp] } = await pool.query(
    `INSERT INTO profile (name, email) VALUES ('Bevis', $1) RETURNING id`, [`proof+ag-filter-${RUN}@example.invalid`]);
  profilId = bp.id;
  const räkna = (typer) => countLocal({ region: [REGION], ...(typer ? { arbetsgivartyp: typer } : {}) },
    { resolved: true, profileId: profilId });
  const [allt, direkt, viaMellanhand] = [await räkna(null), await räkna(DIREKT), await räkna(['bemanning', 'rekrytering'])];
  // the seven ads: A, D bemanning · B rekrytering · C offentlig · E, sole trader företag · one unknown
  kolla('9. bara direkt: företag och offentlig, plus okänd typ', direkt === 4, `${direkt} av ${allt}`);
  kolla('9. bara mellanhänder: bemanning och rekrytering, plus okänd typ', viaMellanhand === 4, `${viaMellanhand} av ${allt}`);

  // ---- 8 ----
  const filer = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filer(p) : /\.(m?js|jsx)$/.test(f) ? [p] : [];
  });
  const iWebbläsaren = ['components', 'lib'].flatMap(filer).filter((f) => /SCB_API_KEY|apiafr/.test(readFileSync(f, 'utf8')));
  kolla('8. ingen kod i webbläsaren känner nyckeln eller SCB:s adress', iWebbläsaren.length === 0, iWebbläsaren.join(', '));
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  if (adIds.length) await pool.query(`DELETE FROM ads WHERE id = ANY($1)`, [adIds]).catch(() => {});
  await pool.query(`DELETE FROM arbetsgivare WHERE orgnr = ANY($1)`, [[...ALLA, GAMMAL]]).catch(() => {});
  if (profilId) await pool.query(`DELETE FROM profile WHERE id = $1`, [profilId]).catch(() => {});
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
