// ------------------------------------------------------------
// How you apply decides whether an ad is worth scoring at all.
//
// Only ~21% of Arbetsförmedlingen's ads carry an application email;
// the rest route through an ATS or a careers page. A campaign can
// only ever mail the 21%, so scoring the other 79% for one buys a
// verdict that cannot be acted on.
//
// The filter runs at queue time in src/score.js, before any LLM
// call — that is where the saving is. Same list, one shared source
// of labels so the chat question and the settings row can't drift.
// ------------------------------------------------------------
export const APPLY_FILTERS = [
  {
    id: 'email',
    label: 'Endast mejl',
    short: 'Mejl',
    hint: 'Bara annonser med en ansökningsadress. Billigast, och det enda som auto-ansökan kan skicka till.',
  },
  {
    id: 'any',
    label: 'Mejl och externa',
    short: 'Alla',
    hint: 'Alla annonser. Du ser mest, men bedömer även sådana du måste söka via arbetsgivarens eget system.',
  },
  {
    id: 'external',
    label: 'Endast externa',
    short: 'Externa',
    hint: 'Bara annonser som söks via webbplats eller ATS. Auto-ansökan kan inte skicka till dessa.',
  },
];

export const APPLY_FILTER_IDS = APPLY_FILTERS.map((f) => f.id);

// NULL in the database means "not asked yet", which reads as
// unrestricted everywhere but still lets the chat ask exactly once.
export function applyFilterLabel(id) {
  return APPLY_FILTERS.find((f) => f.id === id)?.label || 'Mejl och externa';
}
