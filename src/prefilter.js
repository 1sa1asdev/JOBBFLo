// ------------------------------------------------------------
// Free pre-filter: decide which ads deserve an LLM call.
//
// Layer 1 narrows via the API, but its filters are coarse — a
// "Data/IT + Stockholm" query still returns svetsare and barnskötare
// when the freetext is loose. Every one of those costs a scoring
// call, which on a free tier is the scarcest thing there is.
//
// This is deliberately CONSERVATIVE. It only rejects ads with no
// meaningful overlap at all, and every rejection is recorded with a
// reason so nothing disappears silently — hiding a job the user
// hasn't seen is worse than showing a bad one (CLAUDE.md #4).
// ------------------------------------------------------------

const STOP = new Set([
  'och','eller','att','som','för','med','till','den','det','ett','en','av','på',
  'är','vi','du','har','kan','i','om,','om','ska','vill','får','the','and','or',
  'to','of','in','a','an','is','are','you','we','erfarenhet','arbeta','arbete',
  'jobb','tjänst','roll','söker','gärna','minst','krav','inte','okej','samt',
]);

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-zåäöé0-9+#./\s-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function terms(text, { min = 3 } = {}) {
  return new Set(
    norm(text).split(' ')
      .map((w) => w.replace(/^[-.]+|[-.]+$/g, ''))
      .filter((w) => w.length >= min && !STOP.has(w) && !/^\d+$/.test(w))
  );
}

// Occupation words that signal a completely different field. If an
// ad's TITLE is one of these and nothing in the candidate's profile
// matches, it's not worth a call.
const FAR_FIELDS = [
  'svetsare','barnskötare','undersköterska','sjuksköterska','lärare','förskollärare',
  'truckförare','chaufför','bussförare','lastbilsförare','kock','servitör','servitris',
  'städare','lokalvårdare','väktare','elektriker','snickare','murare','målare','rörmokare',
  'montör','maskinoperatör','lagerarbetare','butikssäljare','frisör','massör','tandläkare',
  'veterinär','psykolog','socionom','ekonomiassistent','redovisningsekonom','löneadministratör',
  'platschef','produktionschef','avdelningschef','enhetschef','rektor','präst',
];

// ------------------------------------------------------------
// Returns { keep, score, reason }. `score` is a 0..1 overlap
// measure used only for ordering, never shown as a match score —
// that stays the LLM's job.
// ------------------------------------------------------------
// Swedish compounds are the whole difficulty here: "fullstack" never
// equals "fullstackutvecklare", and "frontend" never equals
// "frontendutvecklare". Token equality therefore drops exactly the
// ads we most want. Substring containment handles compounds without
// needing a stemmer.
const containsTerm = (haystack, term) =>
  term.length >= 4 ? haystack.includes(term) : new RegExp(`\\b${term}\\b`).test(haystack);

// Arbetsförmedlingen already classifies every ad into one of 21
// occupation fields, and layer 1 usually picked one too. Comparing
// those two labels is exact, free, and far more reliable than
// guessing from Swedish compound words — so it decides first, and
// the lexical heuristics below are only the fallback for ads that
// carry no classification (pasted/manual ones).
export const adField = (ad) => ad?.raw?.occupation_field?.label || null;

// Lexical fallback is off by default: it removed ~95% of a random
// pool but also 8 of 17 genuinely good ads. Kept behind a flag rather
// than deleted, since it becomes useful if the criteria are ever
// expanded into an explicit keyword list.
const STRICT_LEXICAL = false;

export function prefilterAd(ad, { criteriaTerms, cvTerms, wantedField = null, minOverlap = 3 }) {
  const field = adField(ad);
  if (wantedField && field) {
    return field === wantedField
      ? { keep: true, score: 0.9, reason: `yrkesområde: ${field}` }
      : { keep: false, score: 0, reason: `fel yrkesområde (${field})` };
  }

  // Without a field label on both sides there is no cheap signal
  // that's safe. Lexical matching was measured at 9/17 recall on
  // ads the model itself rated >=50 — it dropped "Fullstack­utvecklare"
  // and "Webbutvecklare", which is far worse than paying for the call.
  // So: when in doubt, score it.
  if (!STRICT_LEXICAL) return { keep: true, score: 0.5, reason: 'ingen säker signal — bedöms' };

  const title = norm(ad.title);
  const body = norm(`${ad.title} ${ad.description}`);
  const titleTerms = terms(ad.title);
  const bodyTerms = terms(`${ad.title} ${ad.description}`);

  // What the user is looking for NOW is the signal. The CV is
  // background and matches too loosely on its own — a CV mentioning
  // "vård" and "café" otherwise waves through every care and
  // restaurant ad. CV terms only reinforce a criteria match.
  let titleHits = 0;
  for (const t of criteriaTerms) if (containsTerm(title, t)) titleHits++;

  let bodyHits = 0;
  for (const t of criteriaTerms) if (containsTerm(body, t)) bodyHits++;

  let cvHits = 0;
  for (const t of cvTerms) if (bodyTerms.has(t)) cvHits++;

  const score = Math.min(1, (titleHits * 4 + bodyHits * 2 + cvHits) / 20);

  // a criteria word in the job title is the strongest cheap signal
  if (titleHits > 0) return { keep: true, score, reason: 'titelträff' };

  // an unrelated trade in the title needs real evidence to survive
  const farField = FAR_FIELDS.find((f) => title.includes(f));
  if (farField) {
    return bodyHits >= minOverlap + 2
      ? { keep: true, score, reason: `${farField} men ${bodyHits} kriterieord` }
      : { keep: false, score, reason: `annat yrkesområde (${farField})` };
  }

  if (bodyHits < minOverlap) {
    return { keep: false, score, reason: `${bodyHits} kriterieord i texten` };
  }
  return { keep: true, score, reason: `${bodyHits} kriterieord` };
}

// Build the term sets once per search rather than per ad.
export function buildProfileTerms({ criteriaText, cvText, apiFilters = {} }) {
  const wanted = apiFilters?.['occupation-field'];
  return {
    criteriaTerms: terms(criteriaText),
    cvTerms: terms(cvText),
    wantedField: Array.isArray(wanted) ? wanted[0] : (wanted || null),
  };
}
