import { PROVIDERS, ärLokal } from './providers.js';
import { prövaAdress } from './adress.js';

// ------------------------------------------------------------
// Which OpenRouter models a user may pick, per job.
//
// OpenRouter serves hundreds of models. Letting every user pick any of
// them meant every user's grading, letters and costs came from a
// different model — so the measured tokens per task, the cost estimate
// and the coming budget described nobody in particular, and a model
// that cannot hold the checklist format failed quietly for whoever
// happened to choose it. The operator keeps the list (/admin, stored
// in platform_settings.llm_modeller); it starts with exactly the models
// Jobbflo has been run and measured on, and with no free models — free
// tiers on OpenRouter run out within a day of real use.
//
// A saved choice that is later taken off the list is not an error for
// the user: the call uses the first model on the list for that job
// instead (tillåtenKedja), and the settings page shows the new value.
//
// LM Studio and Ollama run whatever the user has loaded; the list does
// not apply to them, their address does (src/adress.js).
// ------------------------------------------------------------

// The jobs a user picks a model for (src/llm.js tiers).
export const NIVÅER = ['fast', 'bulk', 'write', 'smart'];
export const NIVÅNAMN = {
  fast: 'Klassificering och läsning av krav',
  bulk: 'Bedömning',
  write: 'Brev och svar',
  smart: 'Reserv',
};

// What the list starts as. The first model of each job is the
// recommended one and must be OpenRouter's preset (src/providers.js),
// so the estimate, the defaults and the list agree.
export const STANDARDLISTA = {
  fast: ['google/gemini-2.5-flash-lite'],
  bulk: ['google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite'],
  write: ['openai/gpt-oss-120b', 'google/gemini-2.5-flash'],
  smart: ['google/gemini-2.5-flash', 'openai/gpt-oss-120b'],
};

// A list as stored or as sent from /admin: every job present, ids
// trimmed, no duplicates, nothing empty. Returns null when it is not a
// list at all.
export function normaliseraLista(lista) {
  if (!lista || typeof lista !== 'object') return null;
  const ut = {};
  for (const n of NIVÅER) {
    const ids = Array.isArray(lista[n]) ? lista[n] : [];
    ut[n] = [...new Set(ids.map((m) => String(m || '').trim()).filter(Boolean))];
  }
  return ut;
}

let cache = null;
export async function modellista({ färsk = false } = {}) {
  if (!färsk && cache && Date.now() - cache.at < 60_000) return cache.lista;
  // imported here, not at the top: src/llm.js imports this file and
  // reaches the database only when a call needs it
  const { plattformsinställning } = await import('./platform.js');
  const lagrad = normaliseraLista(await plattformsinställning('llm_modeller'));
  // A job left empty on /admin falls back to the standard list for that
  // job: an empty list would leave nobody able to grade at all.
  const lista = Object.fromEntries(NIVÅER.map((n) => [n, lagrad?.[n]?.length ? lagrad[n] : STANDARDLISTA[n]]));
  cache = { lista, at: Date.now() };
  return lista;
}
export const glömModellista = () => { cache = null; };

// The entries of a stored chain ("a, b") that the list allows, as the
// chain to use; the job's first model when none is.
export function tillåtenKedja(värde, nivå, lista) {
  const tillåtna = lista[nivå] || [];
  const kvar = String(värde || '').split(',')
    .map((s) => s.trim().replace(/^openrouter:/, ''))
    .filter((m) => tillåtna.includes(m));
  return kvar.length ? kvar.join(', ') : (tillåtna[0] || null);
}

// One check for everything that saves or tries a provider choice: the
// settings route, the connection test and the model list. null when the
// choice is fine, otherwise what is wrong, in Swedish.
//   val   { provider, modeller: { fast, bulk, write, smart }, baseUrl }
export async function prövaVal(val, { lista, ...adressVal } = {}) {
  const { provider, modeller = {}, baseUrl } = val || {};
  if (!PROVIDERS[provider]) return 'Välj OpenRouter, LM Studio eller Ollama.';
  if (ärLokal(provider)) {
    return baseUrl ? prövaAdress(baseUrl, adressVal) : prövaAdress(PROVIDERS[provider].baseUrl, adressVal);
  }
  if (baseUrl) return 'OpenRouter har en fast adress — lämna bas-URL tom.';
  const l = lista || await modellista();
  for (const n of NIVÅER) {
    const poster = String(modeller[n] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const otillåten = poster.find((m) => !l[n].includes(m.replace(/^openrouter:/, '')));
    if (otillåten) return `${otillåten} finns inte bland modellerna för ${NIVÅNAMN[n].toLowerCase()}.`;
  }
  return null;
}
