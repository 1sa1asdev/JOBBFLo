// ------------------------------------------------------------
// LLM provider registry: OpenRouter, LM Studio and Ollama, nothing else.
//
// There used to be eleven. Every one is a different set of models, a
// different price list and different failure modes, and the cost
// estimate, the measured tokens per task and the budget all assume the
// models Jobbflo has actually been run on. OpenRouter reaches those
// models (and is the one provider that reports what a call cost);
// LM Studio and Ollama are for the user who wants nothing to leave
// their own machine. Which OpenRouter models a user may pick is the
// operator's list (src/modeller.js), not anything the provider serves.
//
// `eu` marks providers that keep data inside the EU. This app sends a
// CV, personal details and employer correspondence to whichever
// provider is picked, so that column is not decoration.
// ------------------------------------------------------------

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    // What Jobbflo is run and measured on (src/kostnad.js estimates with
    // these, and src/modeller.js starts its list with them): cheap
    // reads, a capable grader, a writer that reads well.
    smart: 'google/gemini-2.5-flash',
    fast: 'google/gemini-2.5-flash-lite',
    bulk: 'google/gemini-2.5-flash',
    write: 'openai/gpt-oss-120b',
    eu: false,
    note: 'Rekommenderas. Ger dig modellerna Jobbflo är testat och prissatt med. Du betalar OpenRouter direkt och ser kostnaden innan något dras.',
  },
  lmstudio: {
    label: 'LM Studio (lokalt)',
    baseUrl: 'http://localhost:1234/v1',
    keyUrl: null,
    smart: 'local-model',
    fast: 'local-model',
    bulk: 'local-model',
    write: 'local-model',
    eu: true,                    // never leaves the machine
    note: 'Kör modellen på din egen dator, gratis och utan kvot. I den publicerade appen måste servern nå datorn via en publik https-adress, till exempel en tunnel.',
  },
  ollama: {
    label: 'Ollama (lokalt)',
    baseUrl: 'http://localhost:11434/v1',
    keyUrl: null,
    smart: 'llama3.1',
    fast: 'llama3.1',
    bulk: 'llama3.1',
    write: 'llama3.1',
    eu: true,                    // never leaves the machine
    note: 'Körs på din egen dator och inget data lämnar den. Kräver en någorlunda kraftig dator, och i den publicerade appen en publik https-adress till den.',
  },
};

// The two that run on the user's own machine: no key, any model name,
// and a base URL the user supplies (src/adress.js decides whether the
// server may call it).
export const ärLokal = (provider) => provider === 'lmstudio' || provider === 'ollama';

export const providerList = () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    keyUrl: p.keyUrl,
    smart: p.smart,
    fast: p.fast,
    bulk: p.bulk,
    write: p.write,
    eu: p.eu,
    note: p.note,
    lokal: ärLokal(id),
    needsBaseUrl: ärLokal(id),
    needsKey: !ärLokal(id),
  }));
