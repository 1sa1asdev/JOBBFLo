// ------------------------------------------------------------
// A re-parse of the criteria, merged with what the user set by hand.
//
//   current     api_filters in force now
//   prevParsed  what the model read out of the criteria last time
//   newParsed   what it reads out of them now
//
// A key where current and prevParsed disagree was changed by hand —
// switched on, switched off, or given another value. It keeps the hand
// value while the new parse leaves that key as it was; when the new
// parse moves it, the user has just said something about it in words,
// and the newer statement wins.
//
// The occupation axes are one decision, not three. The API ORs them,
// so a chip that swaps Bransch for Yrkesgrupp is a single choice; if a
// parse brought the field back beside the kept group, the pair would
// fetch the wider of the two and the chip would silently stop working.
// ------------------------------------------------------------
const YRKESAXLAR = ['occupation-name', 'occupation-group', 'occupation-field'];

const lika = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function mergeReparsed({ current, prevParsed, newParsed }) {
  const nu = current || {};
  const förr = prevParsed ?? nu;
  const ny = { ...(newParsed || {}) };

  const nycklar = new Set([...Object.keys(nu), ...Object.keys(förr)]);
  const handändrade = [...nycklar].filter((k) => !lika(nu[k], förr[k]));

  const yrkeFörHand = handändrade.some((k) => YRKESAXLAR.includes(k));
  const yrkeITal = YRKESAXLAR.some((k) => !lika(ny[k], förr[k]));

  const behållna = [];
  for (const k of handändrade) {
    if (YRKESAXLAR.includes(k)) continue;
    if (!lika(ny[k], förr[k])) continue;   // said again in words: words win
    if (nu[k] === undefined) delete ny[k]; else ny[k] = nu[k];
    behållna.push(k);
  }
  if (yrkeFörHand && !yrkeITal) {
    for (const k of YRKESAXLAR) {
      if (nu[k] === undefined) delete ny[k]; else ny[k] = nu[k];
    }
    behållna.push(...YRKESAXLAR.filter((k) => handändrade.includes(k)));
  }
  return { filters: ny, behållna };
}

// The Ort picker shows `searches.location`; it must say what the place
// filters say, or its next save puts back what a chip just took away.
export const orterIFilter = (f) => {
  const o = [...[].concat(f?.municipality ?? []), ...[].concat(f?.region ?? [])];
  return o.length ? o : null;
};
