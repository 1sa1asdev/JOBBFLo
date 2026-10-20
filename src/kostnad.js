import { pool } from './db.js';
import { priceTable } from './prices.js';
import { PROVIDERS } from './providers.js';

// ------------------------------------------------------------
// What a choice of models will cost a user a month, before they spend
// anything.
//
// Tokens per task are measured in Jobbflo (llm_usage, all users, 30 days
// — averages only, nothing of anyone's own), prices are OpenRouter's per
// token. So the estimate carries this app's real prompt and ad lengths,
// not a model card's.
//
// What one judged ad and one sent letter cost:
//   ad      read the requirements with the fast model, re-read with the
//           grading model when the cheap read is thin (ESKALERING of the
//           time), then grade it with the grading model
//   letter  written with the writing model; a share of letters get an
//           answer, which is classified (fast) and replied to (writing)
// ------------------------------------------------------------

// Measured 2026-10-20 over 30 days: 691 fast, 1393 grading and 50
// writing calls. Used until the live averages have enough calls.
const TOKENS_STANDARD = {
  fast: { in: 1918, out: 1050 },
  bulk: { in: 2027, out: 650 },
  write: { in: 1512, out: 802 },
};
// 308 of 692 requirement reads were re-read by the better model.
const ESKALERING = 0.45;
// 200 of 519 sent letters got an answer.
const SVAR_PER_BREV = 0.39;
const VECKOR_PER_MÅNAD = 4.35;

// What a user who changes nothing is offered: the models Jobbflo has
// been run and measured on — OpenRouter's presets in src/providers.js,
// so there is one list, not two.
const { fast: rFast, bulk: rBulk, write: rWrite, smart: rSmart } = PROVIDERS.openrouter;
export const REKOMMENDERADE = { openrouter: { fast: rFast, bulk: rBulk, write: rWrite, smart: rSmart } };

// Models that think before answering bill tokens the user never sees,
// so a per-task average measured on another model undercounts them.
const RESONERANDE = /(^|\/)(o1|o3|o4)|r1\b|reason|think|qwq|gpt-oss|deepseek-r/i;

const förstaModell = (fält) => String(fält || '').split(',')[0].trim() || null;

// The pure arithmetic — prices and tokens handed in, so it can be
// checked without a network.
export function uppskatta({ provider, modeller, priser, tokens = TOKENS_STANDARD,
  annonserPerVecka = 50, brevPerVecka = 5 }) {
  const gratisLeverantör = ['groq', 'ollama', 'lmstudio'].includes(provider);
  const okända = new Set();
  const pris = (modell, t) => {
    if (!modell) return 0;
    if (gratisLeverantör || /:free$/.test(modell)) return 0;
    const p = priser.get(modell);
    if (!p) { okända.add(modell); return 0; }
    return t.in * p.prompt + t.out * p.completion;
  };
  const fast = förstaModell(modeller.fast);
  const bulk = förstaModell(modeller.bulk);
  const write = förstaModell(modeller.write);

  const läsning = pris(fast, tokens.fast) + ESKALERING * pris(bulk, tokens.fast);
  const bedömning = pris(bulk, tokens.bulk);
  const brev = pris(write, tokens.write);
  const svar = SVAR_PER_BREV * (pris(fast, tokens.fast) + pris(write, tokens.write));

  const perAnnons = läsning + bedömning;
  const perBrev = brev + svar;
  const annonserMånad = annonserPerVecka * VECKOR_PER_MÅNAD;
  const brevMånad = brevPerVecka * VECKOR_PER_MÅNAD;
  return {
    perAnnons,
    perBrev,
    månad: annonserMånad * perAnnons + brevMånad * perBrev,
    rader: [
      { vad: 'Läsa annonsernas krav', modell: fast, usd: annonserMånad * läsning,
        not: bulk && bulk !== fast ? `tunna läsningar görs om med ${bulk}` : null },
      { vad: 'Bedöma annonserna', modell: bulk, usd: annonserMånad * bedömning },
      { vad: 'Skriva brev', modell: write, usd: brevMånad * brev },
      { vad: 'Läsa och besvara svar', modell: write, usd: brevMånad * svar },
    ],
    okändaPriser: [...okända],
    resonerande: [...new Set([fast, bulk, write].filter((m) => m && RESONERANDE.test(m)))],
  };
}

// The live averages, where there is enough to average.
async function uppmättaTokens() {
  const { rows } = await pool.query(
    `SELECT tier, avg(prompt_tokens)::float AS inn, avg(completion_tokens)::float AS ut, count(*)::int AS n
     FROM llm_usage
     WHERE at > now() - interval '30 days' AND tier IN ('fast', 'bulk', 'write')
       AND prompt_tokens IS NOT NULL
     GROUP BY tier`);
  const t = structuredClone(TOKENS_STANDARD);
  for (const r of rows) if (r.n >= 20) t[r.tier] = { in: r.inn, out: r.ut };
  return t;
}

// Which of these models Jobbflo has actually run, and how often — the
// "testad" mark next to a choice.
async function körningar(modeller) {
  const lista = [...new Set(modeller.filter(Boolean))];
  if (!lista.length) return {};
  const { rows } = await pool.query(
    `SELECT model, count(*)::int AS n FROM llm_usage WHERE model = ANY($1) GROUP BY model`, [lista]);
  return Object.fromEntries(rows.map((r) => [r.model, r.n]));
}

export async function kostnadFör({ provider, modeller, annonserPerVecka, brevPerVecka }) {
  const [priser, tokens] = await Promise.all([priceTable(), uppmättaTokens()]);
  const svar = uppskatta({ provider, modeller, priser, tokens, annonserPerVecka, brevPerVecka });
  const valda = [modeller.fast, modeller.bulk, modeller.write].map(förstaModell);
  return { ...svar, testade: await körningar(valda), prislistaSaknas: priser.size === 0 };
}
