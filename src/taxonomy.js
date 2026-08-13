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
const TYPES = ['municipality', 'region', 'occupation-field', 'occupation-group'];

let cache = null;      // { [type]: Map(lowercased label -> concept id) }
let loading = null;

async function fetchType(type) {
  const res = await fetch(`${TAXONOMY}?type=${type}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`taxonomy ${type}: ${res.status}`);
  const concepts = await res.json();
  const map = new Map();
  for (const c of concepts) {
    const id = c['taxonomy/id'];
    const label = c['taxonomy/preferred-label'];
    if (!id || !label) continue;
    map.set(label.toLowerCase(), id);
    // "Stockholms län" should also match "Stockholm"
    const short = label.replace(/s? (län|kommun)$/i, '').toLowerCase();
    if (!map.has(short)) map.set(short, id);
  }
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
  const key = String(value).trim().toLowerCase();
  return map.get(key) || map.get(key.replace(/s? (län|kommun)$/i, '')) || null;
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
