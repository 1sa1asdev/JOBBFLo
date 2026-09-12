// ------------------------------------------------------------
// Arbetsförmedlingen taxonomy resolver.
//
// JobSearch's municipality / region / occupation-field filters
// take CONCEPT IDS ("AvNB_uwa_6n6"), not names ("Stockholm").
// Passing a name doesn't error — it silently returns 0 hits,
// which looks exactly like "no jobs matched". Layer 1 produces
// names (that's what an LLM can reliably emit), so everything
// gets translated here before it reaches the API.
// ------------------------------------------------------------

const TAXONOMY = 'https://taxonomy.api.jobtechdev.se/v1/taxonomy/main/concepts';
const TYPES = ['municipality', 'region', 'occupation-field', 'occupation-group',
               'occupation-name', 'employment-type', 'worktime-extent'];

// Words a candidate (or the model) actually uses, mapped to the label
// Arbetsförmedlingen uses. "deltid" is NOT an employment-type — that
// axis is contract length (vikariat, behovsanställning). Hours live on
// worktime-extent, and putting one axis's concept id in the other's
// parameter returns 0 hits rather than an error.
const ALIASES = {
  'worktime-extent': {
    'part-time': 'deltid', parttime: 'deltid', 'deltidsjobb': 'deltid',
    'deltidstjänst': 'deltid', 'extrajobb': 'deltid',
    'full-time': 'heltid', fulltime: 'heltid', 'heltidstjänst': 'heltid',
  },
  'employment-type': {
    permanent: 'tillsvidareanställning', fast: 'tillsvidareanställning',
    'fast anställning': 'tillsvidareanställning',
    temporary: 'tidsbegränsad anställning', vikarie: 'vikariat',
    'sommarjobb': 'säsongsanställning', seasonal: 'säsongsanställning',
    timanställning: 'behovsanställning', 'timmar': 'behovsanställning',
  },
};

let cache = null;      // { [type]: Map(lowercased label -> concept id) }
let loading = null;

async function fetchType(type) {
  const res = await fetch(`${TAXONOMY}?type=${type}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`taxonomy ${type}: ${res.status}`);
  const concepts = await res.json();
  const map = new Map();
  const labels = [];       // original casing, for display in pickers
  for (const c of concepts) {
    const id = c['taxonomy/id'];
    const label = c['taxonomy/preferred-label'];
    if (!id || !label) continue;
    map.set(label.toLowerCase(), id);
    labels.push(label);
    // "Stockholms län" should also match "Stockholm"
    const short = label.replace(/s? (län|kommun)$/i, '').toLowerCase();
    if (!map.has(short)) map.set(short, id);
  }
  map.labels = labels;
  return map;
}

export async function loadTaxonomy() {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      const entries = await Promise.all(
        TYPES.map(async (t) => {
          try {
            return [t, await fetchType(t)];
          } catch (err) {
            console.error(`taxonomy: ${err.message}`);
            return [t, new Map()];
          }
        })
      );
      cache = Object.fromEntries(entries);
      return cache;
    })();
  }
  return loading;
}

const looksLikeConceptId = (v) => typeof v === 'string' && /^[A-Za-z0-9]{4}_[A-Za-z0-9]{3}_[A-Za-z0-9]{3}$/.test(v);

// Resolve one value; returns null when the name is unknown so the
// caller can drop the filter rather than send a zero-hit query.
export async function resolveConcept(type, value) {
  if (!value) return null;
  if (looksLikeConceptId(value)) return value;
  const tax = await loadTaxonomy();
  const map = tax[type];
  if (!map) return null;
  let key = String(value).trim().toLowerCase();
  const alias = ALIASES[type]?.[key];
  if (alias) key = alias;
  return map.get(key)
    || map.get(key.replace(/s? (län|kommun)$/i, ''))
    // labels carry parentheticals: "Tillsvidareanställning (inkl. ...)"
    || [...map.entries()].find(([label]) => label.startsWith(key))?.[1]
    || null;
}

// ------------------------------------------------------------
// Translate a whole layer-1 filter object into API-ready params.
// Unknown names are moved into the freetext `q` instead of being
// dropped — better a broad search than a silently empty one.
// ------------------------------------------------------------
export async function resolveFilters(filters = {}) {
  const out = { ...filters };
  const extraText = [];

  for (const [key, type] of [
    ['municipality', 'municipality'],
    ['region', 'region'],
    ['occupation-field', 'occupation-field'],
    ['occupation-group', 'occupation-group'],
    // The narrowest occupation axis: "undersköterska" rather than the
    // whole of Hälso- och sjukvård. Forwarded but never resolved before,
    // so the one name that would have narrowed best fell through to
    // free-text q — where its words get AND-ed and return nothing.
    ['occupation-name', 'occupation-name'],
    ['employment-type', 'employment-type'],
    ['worktime-extent', 'worktime-extent'],
  ]) {
    const raw = out[key];
    if (raw == null) continue;
    const values = [].concat(raw);
    const resolved = [];
    for (const v of values) {
      const id = await resolveConcept(type, v);
      if (id) resolved.push(id);
      else if (typeof v === 'string' && v.trim()) extraText.push(v.trim());
    }
    if (resolved.length) out[key] = resolved;
    else delete out[key];
  }

  if (extraText.length) {
    out.q = [out.q, ...extraText].filter(Boolean).join(' ');
  }
  return out;
}
