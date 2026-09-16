import crypto from 'node:crypto';
import { pool } from './db.js';
import { llmJson } from './llm.js';
import { verifyQuotes } from './score.js';
import { buildAdProfile, renderAdProfile } from './adprofile.js';
import { renderCvProfile } from './cvprofile.js';

// ------------------------------------------------------------
// The grade, as a checklist.
//
// A 0-100 from a model is a black box and an unstable one: the same
// reposted job came back 25 one time and 50 the next, and a cheaper
// model gave 15, 15, 15 to three different ads. It also answered two
// questions at once — "does this CV meet the requirements" and "is
// this the kind of job I want" — and only the second depends on the
// search.
//
// So the grade is built in two steps that can be checked:
//
//   1. the ad's requirements, read out of the ad once (adprofile.js),
//      each carrying a verbatim quote from the ad
//   2. each requirement answered against the CV, with a verbatim quote
//      from the CV where there is one
//
// and the number is then arithmetic over those rows. Same checklist,
// same number, every time — and every point of it can be traced to a
// line the user can read.
//
// What the search still decides is which ads are worth checking at all
// (filters and vector distance, both free) and a campaign's own hard
// rule (must_criteria, answered here as one extra requirement).
// ------------------------------------------------------------

export const SYSTEM = `Du svarar på om en kandidats CV uppfyller varje krav i en jobbannons.

Du får KRAVEN (redan utlästa ur annonsen, med annonsens egna ord) och kandidatens CV-profil.

För varje krav svarar du med en status:
- "uppfyllt": CV:t visar tydligt att kravet är uppfyllt
- "delvis": CV:t visar något närliggande men inte hela kravet (t.ex. 1 års erfarenhet där 3 krävs, eller ett angränsande verktyg)
- "saknas": CV:t motsäger kravet eller visar tydligt att det inte är uppfyllt
- "okänt": CV:t säger ingenting om saken

REGLER
- "cv_belagg" MÅSTE vara ETT SAMMANHÄNGANDE ordagrant utdrag ur CV-profilen, max 20 ord.
  Klipp aldrig ihop delar med "...". Finns inget belägg: sätt cv_belagg till null och
  status till "okänt" eller "saknas".
- Hitta aldrig på erfarenhet. Att kandidaten "säkert skulle klara det" är inte uppfyllt.
- Bedöm kravet som det står. Lägg inte till egna krav, och mildra inte annonsens.
- En mening per krav i "varfor", på svenska, max 15 ord.
- Svara på ALLA krav du får, i samma ordning, med samma "id".
- Ett krav märkt [KAMPANJREGEL] handlar om ANNONSEN, inte om CV:t. Då får du
  också annonsens roll och krav. Svara "uppfyllt" om annonsen stämmer med
  regeln, "saknas" om den bryter mot den, "okänt" om det inte går att avgöra.
  cv_belagg ska vara null för den raden.

Svara ENDAST med JSON, inga kodstaket:
{"items": [{"id": 0, "status": "uppfyllt|delvis|saknas|okänt", "cv_belagg": "ordagrant ur CV:t eller null", "varfor": "kort"}]}`;

// ------------------------------------------------------------
// The weighting. Deliberately in code, not in a prompt: it is a
// product decision, it changes, and changing it must not cost a single
// model call.
//
// A hard requirement is worth three times a merit — that is the
// difference between "du ska ha" and "det är ett plus om". Unknown is
// not free and not fatal: the ad asked about something the CV does not
// mention, which is worth less than a partial answer and more than a
// contradiction.
// ------------------------------------------------------------
// Not every requirement is the same size, and the first version of this
// weighted them as if they were. Measured on 30 ads:
//
//   "Specialistläkare i allmänmedicin" scored 59 for a developer's CV.
//   Eight rows: the profession missing, the licence missing — and four
//   language rows met, two of them the same requirement counted twice.
//
//   "Butikssäljare Deltid" scored 28 on eight rows that were all
//   personal qualities: ansvarstagande, flexibel, noggrann, utåtriktad.
//   A CV cannot answer those, so every one came back "okänt" — and
//   unknown paid a quarter of a point each.
//
// So weight by what kind of requirement it is, and let the ones you
// either have or do not have decide.
export const SORTER = new Set(['yrke', 'licens', 'utbildning', 'erfarenhet', 'teknik', 'språk', 'egenskap']);

// Ads read before the extractor was asked for a kind still have to be
// weighed, and so does a model that answers with something else. Word
// matching is crude, but "legitimation" is not ambiguous and neither is
// "stresstålig" — and the fallback only has to be better than treating
// a personal quality as a licence.
const MÖNSTER = [
  [/legitimation|licens|behörighet|certifikat|certifiering|körkort|medborgarskap|säkerhetspröv|registerutdrag|utdrag ur belastning/i, 'licens'],
  [/examen|utbildning|högskole|universitet|gymnasie|yrkeshögskola|kandidat|master|civilingenjör/i, 'utbildning'],
  [/\b\d+\s*års?\b|erfarenhet|vana av|arbetat med/i, 'erfarenhet'],
  // Word boundary, or "programmeringsspråk" is a language requirement:
  // Rust and C/C++ were weighed as if they were Swedish and English.
  [/\bspråk\b|\bsvenska\b|\bengelska\b|\bnorska\b|\bdanska\b|\bfinska\b|\btyska\b|\barabiska\b|\bspanska\b/i, 'språk'],
  [/noggrann|flexib|stresstål|social|utåtriktad|serviceinriktad|servicekänsla|ansvarstagande|driven|positiv|engagerad|självgående|initiativ|samarbet|kommunikativ|ödmjuk|strukturerad|målinriktad|resultatinriktad|prestigelös|nyfiken|lyhörd/i, 'egenskap'],
];

export function gissaSort(name, field = null) {
  const t = String(name || '');
  for (const [re, sort] of MÖNSTER) if (re.test(t)) return sort;
  // `field` is the occupational AREA ("IT", "vård", "utbildning"), not
  // the kind of requirement. Reading it as a kind made every
  // requirement in a teaching job a degree: "pedagogisk och tydlig"
  // became a gate and dropped an ad the CV fits from 85 to 25.
  if (field === 'språk') return 'språk';
  return 'teknik';
}

const VIKT = {
  yrke: 6, licens: 6, utbildning: 5, erfarenhet: 3, teknik: 3, språk: 1, egenskap: 0.5,
};
const VIKT_ÖVRIGT = 3;

// Unknown is not a quarter of met. A CV that says nothing about a
// technical requirement is evidence of nothing, and paying it out is
// how eight unanswerable rows became 28 points.
const VÄRDE = { uppfyllt: 1, delvis: 0.5, okänt: 0.1, saknas: 0 };

// A gate is a requirement you either hold or do not: the profession
// itself, a licence, a degree, or anything the ad named as excluding.
// Missing one is not a deduction, it is a ceiling — a doctor's job is
// not a 59 for someone without the licence because the language
// requirements fit.
const GRIND = new Set(['yrke', 'licens', 'utbildning', 'kampanjkrav']);
const TAK_BRUTEN_GRIND = 25;

// Personal qualities are stated in almost every ad and cannot be
// checked against a CV. They stay visible in the list — the ad does ask
// for them — but an unanswerable row must not carry the number.
const ODÖMBAR = (i) => i.kind === 'egenskap' && (i.status === 'okänt' || i.status === 'saknas');

export function scoreFromItems(items = []) {
  const vikt = (i) => (i.weight === 'meriterande'
    ? 1
    : (VIKT[i.kind] ?? VIKT_ÖVRIGT) * (i.dealbreaker ? 1.5 : 1));

  const räknade = items.filter((i) => VÄRDE[i.status] !== undefined && !ODÖMBAR(i));
  const hårda = räknade.filter((i) => i.weight !== 'meriterande');
  // Nothing measurable in the ad at all — eight rows of "vi söker dig
  // som är flexibel". Answering that with a number would be inventing
  // one; the list says so instead, and a campaign will not send on it.
  if (!hårda.length) {
    return { score: null, krav: [0, 0], plus: [0, 0], brutna: [], odömbar: true };
  }

  let summa = 0;
  let max = 0;
  for (const i of räknade) {
    const v = vikt(i);
    summa += v * VÄRDE[i.status];
    max += v;
  }
  let score = Math.round((summa / max) * 100);

  // Only a real gate caps. The extractor's own "dealbreakers" list is
  // too generous to hold a veto — it named "pedagogisk och tydlig" and
  // "erfarenhet av användarstöd", which dropped a teaching job the CV
  // fits from 85 to 25. Being on that list makes a requirement weigh
  // more (it is in the list twice over), never a stop on its own.
  // "Okänt" caps for a licence — not holding one is the default, and an
  // ad that asks for it is asking. It must NOT cap for the campaign
  // rule: there "okänt" means the model could not tell from the ad, and
  // treating that as a broken rule stops the campaign on every ad it
  // was unsure about.
  const brutna = räknade.filter((i) => GRIND.has(i.kind)
    && (i.status === 'saknas'
      || (i.status === 'okänt' && i.kind !== 'kampanjkrav')));
  if (brutna.length && score > TAK_BRUTEN_GRIND) score = TAK_BRUTEN_GRIND;

  // Thin evidence should not read as certainty. Two met requirements is
  // a good sign, not a perfect match — a McDonald's ad whose only two
  // stated requirements were met came out at 100, which says more about
  // the ad than about the candidate.
  // 100 has to mean something. At 60 + 10 per row, four met rows read
  // as a perfect match — a teaching ad with four requirements came out
  // at 100 against a CV that fits it well but not perfectly. Six rows
  // is the earliest a top mark is earned.
  const tak = 40 + 10 * hårda.length;
  if (score > tak) score = tak;

  const andel = (w) => {
    const r = räknade.filter((i) => (w === 'krav'
      ? i.weight !== 'meriterande' : i.weight === 'meriterande'));
    return [r.filter((i) => i.status === 'uppfyllt').length, r.length];
  };
  return { score, krav: andel('krav'), plus: andel('meriterande'), brutna: brutna.map((i) => i.name) };
}

export const sammanfatta = ({ krav, plus, brutna = [], odömbar = false }, items = []) => {
  // "0 av 0 krav uppfyllda" is not what happened. The ad asked only for
  // personal qualities — ansvarstagande, flexibel, utåtriktad — and a
  // CV cannot answer those, so there is nothing to score rather than
  // nothing met.
  if (odömbar) {
    return `Inga mätbara krav — annonsen ber bara om personliga egenskaper (${items.length} rader)`;
  }
  const saknade = items
    .filter((i) => i.weight !== 'meriterande' && (i.status === 'saknas' || i.status === 'delvis'))
    .map((i) => i.name).slice(0, 3);
  return [
    `${krav[0]} av ${krav[1]} krav uppfyllda`,
    plus[1] ? `${plus[0]} av ${plus[1]} meriterande` : null,
    brutna.length ? `stoppas av: ${brutna.join(', ')}` : (saknade.length ? `saknas: ${saknade.join(', ')}` : null),
  ].filter(Boolean).join(' · ');
};

// The cache key covers everything the answer depends on: the CV, and a
// campaign's own hard rule when there is one. Without the rule in the
// key, the first campaign to check an ad would leave its private
// requirement in the row every other search then reads.
export const cvKey = (cvText, mustCriteria = null) => crypto.createHash('sha256')
  .update(`${cvText || ''}\u0000${mustCriteria || ''}`).digest('hex').slice(0, 16);

// The ad's requirements, read once and kept on the ad. Every search
// that finds this ad reuses them, and so does every future CV.
async function kravFörAnnons(ad) {
  if (ad.ad_profile) return ad.ad_profile;
  const profil = await buildAdProfile(ad);
  await pool.query(
    `UPDATE ads SET ad_profile = $2::jsonb, ad_profile_at = now(), ad_profile_model = $3
     WHERE id = $1`, [ad.id, JSON.stringify(profil), profil.__model || null]);
  return profil;
}

// ------------------------------------------------------------
// Check one ad against one CV. Reused across searches: the answer
// depends on the ad and the CV, and on nothing else.
// ------------------------------------------------------------
export async function checkAd(ad, {
  cvText, cvProfile, mustCriteria = null, force = false, fråga = llmJson,
} = {}) {
  const nyckel = cvKey(cvText, mustCriteria);
  if (!force) {
    const { rows: [fanns] } = await pool.query(
      `SELECT * FROM ad_checks WHERE ad_id = $1 AND cv_key = $2`, [ad.id, nyckel]);
    if (fanns) return { ...fanns, återanvänd: true };
  }

  const profil = await kravFörAnnons(ad);
  const cvRenderad = renderCvProfile(cvProfile) || cvText || '';
  if (!cvRenderad.trim()) throw new Error('Inget CV inlagt — ladda upp ett CV innan annonser kan bedömas.');

  const dealbreakers = new Set((profil.dealbreakers || []).map((d) => String(d).toLowerCase()));
  const krav = (profil.requires || []).map((r, i) => ({
    id: i,
    name: r.name,
    field: r.field || null,
    kind: SORTER.has(r.kind) ? r.kind : gissaSort(r.name, r.field),
    weight: r.weight === 'meriterande' ? 'meriterande' : 'krav',
    // Only a quote the extractor's own check found in the ad. The
    // requirement stays either way — the model read it somewhere — but
    // a quote that is not in the ad must never reach the UI, which
    // highlights it as the employer's words (CLAUDE.md #5).
    evidence: r.verbatim === false ? null : (r.evidence || null),
    dealbreaker: dealbreakers.has(String(r.name).toLowerCase()),
  }));

  // Years, education and language are requirements too, and the ad
  // states them apart from the list. Left out, a CV with none of the
  // required schooling scored as if the ad had never asked.
  if (profil.years_required) {
    krav.push({ id: krav.length, name: `${profil.years_required} års erfarenhet`,
      field: profil.role?.field || null, kind: 'erfarenhet',
      weight: 'krav', evidence: null, dealbreaker: false });
  }
  if (profil.education_required?.what) {
    krav.push({ id: krav.length, name: profil.education_required.what, field: 'utbildning',
      kind: 'utbildning', weight: 'krav',
      evidence: profil.education_required.evidence || null, dealbreaker: false });
  }
  for (const s of profil.languages || []) {
    krav.push({ id: krav.length, name: `${s.name}${s.level ? ` (${s.level})` : ''}`,
      field: 'språk', kind: 'språk', weight: 'krav',
      evidence: s.evidence || null, dealbreaker: false });
  }

  // The same requirement, twice. A doctor's ad listed Svenska and
  // Engelska under requires AND under languages, so four of its eight
  // rows were language — and language was the only thing the CV met.
  // Keyed on the first word of the name, which is what differs between
  // "Svenska i tal och skrift" and "Svenska (mycket goda kunskaper)".
  const sedda = new Set();
  const unika = [];
  for (const k of krav) {
    const nyckelOrd = String(k.name || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
    const key = `${k.kind}|${nyckelOrd}`;
    if (sedda.has(key)) continue;
    sedda.add(key);
    unika.push({ ...k, id: unika.length });
  }
  krav.length = 0;
  krav.push(...unika);
  // A campaign's own hard rule is answered as one more requirement, so
  // it lands in the same checklist the user reads rather than being a
  // separate invisible veto.
  // It is a gate, unlike the extractor's guessed dealbreakers: the user
  // wrote this rule themselves and called it a requirement, so an ad
  // that fails it cannot be talked up by everything else fitting.
  if (mustCriteria?.trim()) {
    krav.push({ id: krav.length, name: mustCriteria.trim().slice(0, 120), field: 'kampanjkrav',
      kind: 'kampanjkrav', weight: 'krav', evidence: null, dealbreaker: true });
  }

  if (!krav.length) {
    // An ad with no stated requirements is not a match and not a
    // mismatch. Recorded as such rather than scored, so it is visible
    // instead of being quietly ranked at zero.
    const rad = { ad_id: ad.id, cv_key: nyckel, items: [], score: null,
      summary: 'Annonsen anger inga krav', must_missing: null, model: null };
    await spara(rad);
    return rad;
  }

  let usedModel = null;
  // `fråga` is the model call, injectable so the checklist can be
  // tested end to end without a provider — the arithmetic and the
  // quote checking are the parts most worth testing, and they must not
  // need a working key to run.
  const svar = await fråga({
    onModel: (m) => { usedModel = m; },
    tier: 'bulk',
    // Sixteen requirements, each with a quote and a sentence, does not
    // fit in 2000 — two ads came back as truncated JSON and were
    // recorded as failures. Length is the cheap half of this call.
    maxTokens: 4000,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `## KRAV\n${krav.map((k) => `${k.id}. `
        + `${k.kind === 'kampanjkrav' ? '[KAMPANJREGEL] ' : `[${k.weight}] `}${k.name}`
        + `${k.evidence ? ` — annonsen: "${k.evidence}"` : ''}`).join('\n')}`
        + `\n\n## CV-PROFIL\n${cvRenderad.slice(0, 9000)}`
        // The campaign rule asks about the AD ("bara programmeringsroller,
        // inga konsultbolag"), so the model needs the ad in front of it.
        // Asked with only the CV in view it answered "the CV does not say",
        // which the gate then read as a broken rule — six live verdicts in
        // a row capped at 25 for a rule none of them had actually failed.
        + (mustCriteria?.trim()
          ? `\n\n## ANNONSEN (för kampanjregeln)\n${(renderAdProfile(profil) || '').slice(0, 2500)}`
          : ''),
    }],
  });

  const svarPerId = new Map((svar.items || []).map((i) => [Number(i.id), i]));
  // Quotes from the CV are verified the same way quotes from an ad are
  // (CLAUDE.md #5). A quote that is not in the CV loses its claim to
  // evidence, and the status drops with it: an unsourced "uppfyllt" is
  // the exact failure this design exists to prevent.
  const kontrollerade = verifyQuotes(
    [...svarPerId.values()].map((i) => ({ ...i, quote: i.cv_belagg })), cvRenderad);
  const verifierad = new Map(kontrollerade.map((i) => [Number(i.id), i]));

  const items = krav.map((k) => {
    const s = verifierad.get(k.id) || {};
    const status = ['uppfyllt', 'delvis', 'saknas', 'okänt'].includes(s.status) ? s.status : 'okänt';
    const belagg = s.verbatim ? s.cv_belagg : null;
    return {
      ...k,
      status: status === 'uppfyllt' && !belagg ? 'delvis' : status,
      cv_belagg: belagg,
      varfor: String(s.varfor || '').slice(0, 160) || null,
    };
  });

  const poäng = scoreFromItems(items, profil);
  const rad = {
    ad_id: ad.id,
    cv_key: nyckel,
    items,
    score: poäng.score,
    summary: sammanfatta(poäng, items),
    must_missing: poäng.brutna?.length ? poäng.brutna : null,
    model: usedModel,
  };
  await spara(rad);
  return rad;
}

async function spara(rad) {
  await pool.query(
    `INSERT INTO ad_checks (ad_id, cv_key, items, score, summary, must_missing, model, checked_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6::text[], $7, now())
     ON CONFLICT (ad_id, cv_key) DO UPDATE SET
       items = EXCLUDED.items, score = EXCLUDED.score, summary = EXCLUDED.summary,
       must_missing = EXCLUDED.must_missing, model = EXCLUDED.model, checked_at = now()`,
    [rad.ad_id, rad.cv_key, JSON.stringify(rad.items), rad.score, rad.summary,
     rad.must_missing, rad.model]);
}

// ------------------------------------------------------------
// The checklist in the shape the rest of the app already reads.
//
// match_results keeps carrying score, summary, matched and flags,
// because the list, the campaign threshold, the letters and the skills
// gap are all built on them. What changes is where they come from: the
// quotes are the ad's own words from the requirement rows, so the
// highlighting invariant holds by construction.
// ------------------------------------------------------------
export function tillMatchResult(rad) {
  const matched = (rad.items || [])
    .filter((i) => i.status === 'uppfyllt' && i.evidence)
    .map((i) => ({ quote: i.evidence, why: i.varfor || i.name, verbatim: true }));
  const flags = (rad.items || [])
    .filter((i) => i.status === 'saknas' || i.status === 'delvis')
    .map((i) => ({
      quote: i.evidence || null,
      why: i.varfor || (i.status === 'delvis' ? `delvis: ${i.name}` : `saknas: ${i.name}`),
      tag: i.name?.slice(0, 40) || null,
      verbatim: Boolean(i.evidence),
    }));
  return { score: rad.score, summary: rad.summary, matched, flags };
}
