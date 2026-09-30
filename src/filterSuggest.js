import { pool } from './db.js';
import { loadTaxonomy } from './taxonomy.js';
import { countLocal, countLocalMany } from './localsearch.js';
import { nearestOccupations } from './taxonomyVectors.js';

// ------------------------------------------------------------
// Filters as two states: the ones the user stated, and the ones the
// app could add.
//
// A filter narrows what the scorer has to read, and every narrowing is
// also a set of jobs the user will never see. So the app does not get
// to decide that on its own. What the user's words name is ON; anything
// further the app can offer is OFF until the user takes it — shown with
// the count it would cost, because "Data/IT" means nothing and
// "1288 → 566 annonser" is a decision somebody can actually make.
//
// Occupation suggestions come from the taxonomy itself, never from a
// model spelling a label. Nearest-neighbour over the embedded labels
// when the embedder answers; a plain word match over the same labels
// when it does not. The second exists because the first depends on a
// paid provider, and a feature that goes blank when a key runs out is
// worse than one that gets a little less clever.
// ------------------------------------------------------------


// The filters this app can switch, in the order they are offered. The
// occupation axes are OR-ed by the API (measured: field + group returns
// the wider of the two), so they are mutually exclusive here — offering
// a group means offering it INSTEAD of the field, never on top.
const YRKESAXLAR = ['occupation-name', 'occupation-group', 'occupation-field'];

const ord = (t) => String(t || '').toLowerCase()
  .normalize('NFKC')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .split(' ')
  .filter((w) => w.length >= 4);

// ------------------------------------------------------------
// Occupation candidates for some text.
// ------------------------------------------------------------
// Words that say nothing about WHICH occupation. Left in, "roller" (from
// "utvecklar roller") matched the label "Controller", and a city or
// "deltid" matched any label that happened to contain it.
const INTE_YRKE = new Set(['roller', 'rollen', 'jobb', 'jobbet', 'jobba', 'arbete',
  'arbeta', 'tjänst', 'tjänster', 'deltid', 'heltid', 'deltidsjobb', 'extrajobb',
  'sommarjobb', 'söker', 'inom', 'eller', 'gärna', 'helst', 'något', 'någon',
  'annat', 'både', 'erfarenhet', 'utan', 'med', 'till', 'från', 'kontor',
  'distans', 'hybrid', 'stad', 'staden', 'nära', 'omnejd']);

async function viaText(text, k) {
  const tax = await loadTaxonomy();
  const orter = new Set([
    ...(tax.municipality?.labels || []), ...(tax.region?.labels || []),
  ].flatMap((l) => ord(l)));
  const sokord = [...new Set(ord(text)
    // "lagerjobb", "vårdjobb", "butiksarbete": the occupation is the
    // front of the compound, and the suffix only says it is a job.
    .map((w) => w.replace(/(jobb|jobbet|arbete|tjänst)$/u, ''))
    .filter((w) => w.length >= 4 && !INTE_YRKE.has(w) && !orter.has(w)))];
  // Deduplicated: "Frontend, backend, mjukvaru och frontend" counted
  // frontend twice, so a label covering it outscored one that covered
  // mjukvaru — and the developer group dropped out of the suggestions.
  if (!sokord.length) return { 'occupation-group': [], 'occupation-name': [] };

  const ut = {};
  for (const typ of ['occupation-group', 'occupation-name']) {
    const karta = tax[typ];
    const traffar = [];
    for (const label of karta?.labels || []) {
      const labelord = ord(label);
      // A search word counts when it sits inside a label word or the
      // other way round — "utvecklar" inside "systemutvecklare",
      // "mjukvaru" inside "mjukvaruutvecklare". Swedish compounds make a
      // whole-word match nearly useless.
      // The label word must be substantial to count as containing the
      // search word the other way round: "assistent" inside
      // "ekonomiassistent" is real, but a four-letter label fragment
      // inside a long search word is how VD-assistent turned up for an
      // accounting search.
      let tackt = 0;
      for (const w of sokord) {
        if (labelord.some((l) => l.includes(w) || (l.length >= 6 && w.includes(l) && l.length >= w.length * 0.6))) {
          tackt += 1;
        }
      }
      if (tackt) {
        traffar.push({
          concept_id: karta.get(label.toLowerCase()),
          label,
          // Share of the user's words the label explains, so a label that
          // happens to contain one common word does not outrank one that
          // covers the whole request.
          styrka: tackt / sokord.length,
        });
      }
    }
    // Only the top tier. A label covering one word of three is not a
    // weaker suggestion, it is a different job that shares a word.
    const bast = Math.max(0, ...traffar.map((x) => x.styrka));
    ut[typ] = traffar
      .filter((x) => x.styrka >= Math.max(0.5, bast * 0.99))
      .sort((a, b) => b.styrka - a.styrka || a.label.length - b.label.length)
      .slice(0, k);
  }
  return ut;
}

// What the user excluded is not what they asked for. "extrajobb, deltid
// i Stockholm, ej lager" suggested Lager- och terminalpersonal — the one
// occupation the user had ruled out. A negation runs to the next comma
// or full stop, which is how people write these lists.
export const utanNegationer = (text) => String(text || '')
  .replace(/\b(ej|inte|ingen|inget|inga|utom|förutom|undvik|undviker|slipper|aldrig|no|not)\b[^,.;\n]*/giu, ' ');

export async function occupationCandidates(rå, { k = 3 } = {}) {
  const text = utanNegationer(rå);
  try {
    const n = await nearestOccupations(text, { k });
    // Embedded labels exist only after buildTaxonomyVectors has run; an
    // empty table answers with nothing rather than an error.
    if (n['occupation-group']?.length || n['occupation-name']?.length) {
      // Cosine distance, lower is closer. Past ~0.55 the "nearest" group
      // is merely the least unrelated one in Sweden, and suggesting it
      // would be noise dressed as a recommendation.
      for (const typ of Object.keys(n)) n[typ] = n[typ].filter((x) => x.avstand < 0.55);
      return { källa: 'embedding', ...n };
    }
  } catch { /* provider down or table empty — the text match stands in */ }
  return { källa: 'text', ...(await viaText(text, k)) };
}

// ------------------------------------------------------------
// What a set of filters returns right now.
// ------------------------------------------------------------
// Counted in the pool, not over HTTP. The suggestions are what a
// filter WOULD leave to look at, and what the app can actually show is
// what it holds — a count from the API would promise ads that are not
// here. It is also the difference between a dozen round trips and a
// dozen indexed queries: 2.1s became milliseconds.
export async function hitCount(filters) {
  return countLocal(filters || {});
}

// ------------------------------------------------------------
// The two states for one search.
// ------------------------------------------------------------
const etikett = (key, value) => {
  const namn = {
    'occupation-field': 'Bransch', 'occupation-group': 'Yrkesgrupp',
    'occupation-name': 'Yrke', 'municipality': 'Ort', 'region': 'Län',
    'employment-type': 'Anställningsform', 'worktime-extent': 'Omfattning',
    experience: 'Erfarenhet', trainee: 'Trainee/praktik', larling: 'Lärling',
    remote: 'Distans', q: 'Fritext',
  }[key] || key;
  const varde = value === false ? (key === 'experience' ? 'krävs inte' : 'nej')
    : value === true ? 'ja'
    : Array.isArray(value) ? value.join(', ') : String(value);
  return { namn, varde };
};

// ------------------------------------------------------------
// The answer, kept for a few minutes.
//
// Counting what each narrowing would leave costs about 280ms per
// count over 43k ads, and there are a dozen of them — 700ms every time
// the search view loads, for numbers that change when the filters
// change, the criteria change, or the pool drifts by a handful of ads.
//
// So the key is everything that can change the answer quickly, and
// time takes care of the rest: a new ad moves a count by one, which is
// not worth 700ms on every render to notice.
// ------------------------------------------------------------
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

export async function suggestFilters(searchId) {
  const { rows: [nyckelrad] } = await pool.query(
    `SELECT criteria_text, api_filters FROM searches WHERE id = $1 AND deleted_at IS NULL`,
    [searchId]);
  if (!nyckelrad) throw new Error('sökningen finns inte');
  const nyckel = `${searchId}|${JSON.stringify(nyckelrad.api_filters)}|${nyckelrad.criteria_text}`;
  const träff = cache.get(nyckel);
  if (träff && Date.now() - träff.tid < CACHE_MS) return träff.svar;

  const svar = await beräknaFörslag(searchId);
  cache.set(nyckel, { tid: Date.now(), svar });
  // Bounded: one entry per search and filter set, and a user has a
  // handful of searches. Cleared wholesale rather than tracked.
  if (cache.size > 40) cache.clear();
  return svar;
}

async function beräknaFörslag(searchId) {
  const { rows: [s] } = await pool.query(
    `SELECT id, criteria_text, api_filters, location FROM searches
     WHERE id = $1 AND deleted_at IS NULL`, [searchId]);
  if (!s) throw new Error('sökningen finns inte');

  const aktiva = { ...(s.api_filters || {}) };

  const på = Object.entries(aktiva)
    .filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))
    .map(([key, value]) => ({ key, value, ...etikett(key, value) }));

  // Candidates, each a complete alternative filter set, so the count
  // shown is what would actually be fetched.
  const kandidater = [];
  const utanYrke = Object.fromEntries(
    Object.entries(aktiva).filter(([k]) => !YRKESAXLAR.includes(k)));

  const yrken = await occupationCandidates(s.criteria_text || '');
  for (const typ of ['occupation-group', 'occupation-name']) {
    for (const y of yrken[typ] || []) {
      if ([].concat(aktiva[typ] || []).includes(y.label)) continue;
      // Replaces whatever occupation axis is on, rather than adding to
      // it: the API ORs these, so adding a group to a field narrows
      // nothing at all.
      kandidater.push({
        key: typ, value: y.label, ersätter: YRKESAXLAR.filter((k) => aktiva[k]),
        filter: { ...utanYrke, [typ]: y.label },
        varför: typ === 'occupation-name'
          ? 'Smalast: bara exakt den yrkesbenämningen'
          : aktiva['occupation-field']
            ? 'Yrkesgrupp i stället för hela branschen'
            : 'Bara den här yrkesgruppen',
      });
    }
  }

  // Distans, trainee and lärling are gone from this list: the ad data
  // the app holds does not carry them, so the pool cannot honour them
  // (see src/localsearch.js). A suggestion the search would then
  // ignore is worse than no suggestion.
  const enkla = [
    ['experience', false, 'Bara jobb som inte kräver erfarenhet'],
    ['worktime-extent', 'Deltid', 'Bara deltid'],
    ['worktime-extent', 'Heltid', 'Bara heltid'],
    ['employment-type', 'Tillsvidareanställning', 'Bara tillsvidare'],
  ];
  for (const [key, value, varför] of enkla) {
    if (aktiva[key] != null) continue;
    kandidater.push({ key, value, filter: { ...aktiva, [key]: value }, varför });
  }

  // One statement for every count, including the current one. A dozen
  // separate queries cost 0.9-1.2s per load of the search view, nearly
  // all of it waiting between round trips rather than counting.
  const antal = await countLocalMany([aktiva, ...kandidater.map((k) => k.filter)])
    .catch(() => []);
  const nu = antal[0] ?? null;
  const räknade = kandidater.map((k, i) => ({ ...k, träffar: antal[i + 1] ?? null }));

  const av = räknade
    // Only narrowings that are real and survivable. A suggestion that
    // changes nothing is noise; one that empties the search is a trap.
    // "Heltid: 544 → 526" is not a decision, it is a chip; a cut under a
    // tenth is left out.
    .filter((k) => k.träffar != null && k.träffar > 0 && (nu == null || k.träffar <= nu * 0.9))
    // Mildest narrowing first. Sorted the other way, "Restaurangchef — 1
    // annons" led the list for a search about waiting tables: the most
    // drastic cut presented as the top recommendation.
    .sort((a, b) => b.träffar - a.träffar)
    .slice(0, 6)
    .map(({ filter, ...k }) => ({ ...k, ...etikett(k.key, k.value) }));

  return { träffar: nu, på, av, yrkeskälla: yrken.källa };
}
