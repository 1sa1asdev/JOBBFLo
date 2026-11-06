// The employer types a search or campaign can be limited to
// (src/arbetsgivare.js decides what an ad's employer is). Shared by the
// server, which validates and filters, and the UI, which names them.
export const TYPER = ['foretag', 'offentlig', 'bemanning', 'rekrytering'];
export const TYPNAMN = { foretag: 'Företag', offentlig: 'Offentlig', bemanning: 'Bemanning', rekrytering: 'Rekrytering' };
export const DIREKT = ['foretag', 'offentlig'];

// A filter value as stored: the types to keep, known ones only, in a
// fixed order. null means no filter — nothing chosen is not a filter
// that matches nothing, and everything chosen is the same as none.
export function rensaTyper(v) {
  const valda = TYPER.filter((t) => [].concat(v ?? []).includes(t));
  return valda.length && valda.length < TYPER.length ? valda : null;
}
