// ------------------------------------------------------------
// LLM provider registry.
//
// Everything except Anthropic speaks the OpenAI chat-completions
// shape, so one client covers them all — a provider is really
// just a base URL + default model pair.
//
// `eu` marks providers that process data inside the EU. This app
// sends a CV, personal details and employer correspondence to
// whichever provider is picked, so that column is not decoration.
// ------------------------------------------------------------

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    smart: 'google/gemma-4-31b-it:free',
    fast: 'nvidia/nemotron-nano-9b-v2:free',
    eu: false,
    note: 'Router till många modeller. Gratisnivå finns men har dagskvot (~50 anrop); $10 credits ger 1000/dag.',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    smart: 'deepseek-chat',
    fast: 'deepseek-chat',
    eu: false,
    note: 'Billigast per token av de bra modellerna. Data behandlas i Kina — se GDPR-noten.',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    smart: 'mistral-large-latest',
    fast: 'mistral-small-latest',
    eu: true,
    note: 'Franskt bolag, data inom EU. Bra val om GDPR väger tungt. Gratisnivå finns.',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    smart: 'llama-3.3-70b-versatile',
    fast: 'llama-3.1-8b-instant',
    eu: false,
    note: 'Mycket snabb inferens, generös gratisnivå. Öppna modeller (Llama m.fl.).',
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    smart: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fast: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
    eu: false,
    note: 'Brett urval av öppna modeller.',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    smart: 'gemini-2.5-flash',
    fast: 'gemini-2.5-flash-lite',
    eu: false,
    note: 'Generös gratisnivå via AI Studio.',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    smart: 'gpt-4o',
    fast: 'gpt-4o-mini',
    eu: false,
    note: 'Ingen gratisnivå.',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: null,               // uses the Anthropic SDK, not OpenAI-compatible
    keyUrl: 'https://console.anthropic.com/settings/keys',
    smart: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5',
    eu: false,
    note: 'Bäst kvalitet i den här appens prompter. Ingen gratisnivå.',
  },
  ollama: {
    label: 'Ollama (lokalt)',
    baseUrl: 'http://localhost:11434/v1',
    keyUrl: null,
    smart: 'llama3.1',
    fast: 'llama3.1',
    eu: true,                    // never leaves the machine
    note: 'Körs på din egen dator. Gratis och inget data lämnar maskinen — men kräver en någorlunda kraftig dator.',
  },
  custom: {
    label: 'Egen (OpenAI-kompatibel)',
    baseUrl: null,               // user supplies
    keyUrl: null,
    smart: '',
    fast: '',
    eu: null,
    note: 'Valfri endpoint som följer OpenAI:s chat/completions-format.',
  },
};

export const providerList = () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    keyUrl: p.keyUrl,
    smart: p.smart,
    fast: p.fast,
    eu: p.eu,
    note: p.note,
    needsBaseUrl: p.baseUrl === null && id !== 'anthropic',
    needsKey: id !== 'ollama',
  }));
