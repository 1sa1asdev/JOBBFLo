// ------------------------------------------------------------
// Which /api/pulse requests one beacon round makes, and which answer
// belongs to which subscriber (lib/beacon.jsx). Pure, so
// scripts/prove-beacon.js can check it without a browser.
//
// The route answers one search and one address finder per request. The
// UI shows at most one of each today, so a round is one request; should
// two lists ever be on screen at once, each id gets its own request
// rather than one silently overwriting the other.
// ------------------------------------------------------------
export const SVARSNYCKEL = { global: 'version', search: 'search', kampanjer: 'kampanjer', adresser: 'adresser' };

// subs: [{ del, param }] — the subscribers due this round.
// Returns the query strings to send, and for each subscriber the index
// of the answer to read.
export function planera(subs) {
  const sökningar = [];
  const adressökningar = [];
  let kampanjer = false;
  for (const s of subs) {
    if (s.del === 'search' && !sökningar.includes(s.param)) sökningar.push(s.param);
    if (s.del === 'adresser' && !adressökningar.includes(s.param)) adressökningar.push(s.param);
    if (s.del === 'kampanjer') kampanjer = true;
  }
  const antal = Math.max(1, sökningar.length, adressökningar.length);
  const frågor = Array.from({ length: antal }, (_, i) => {
    const q = new URLSearchParams();
    if (sökningar[i]) q.set('search', sökningar[i]);
    if (adressökningar[i]) q.set('adresser', adressökningar[i]);
    if (i === 0 && kampanjer) q.set('delar', 'kampanjer');
    return q.toString();
  });
  const svarIndex = (s) => (s.del === 'search' ? sökningar.indexOf(s.param)
    : s.del === 'adresser' ? adressökningar.indexOf(s.param) : 0);
  return { frågor, svarIndex };
}

// The version a subscriber should compare, from the round's answers.
export const versionFör = (s, svar, svarIndex) => svar[svarIndex(s)]?.[SVARSNYCKEL[s.del]] ?? null;
