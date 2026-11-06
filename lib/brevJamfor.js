// ------------------------------------------------------------
// The ad's words that the letter being written also uses — so the ad
// text can light them up while the user types (markParagraph in
// LetterView.jsx, the same marking the grading's quotes use).
//
// Word matching in the browser, no model: it runs on every pause in
// typing and has to be instant and free. A mention is not evidence;
// the grade is the checklist (src/checklist.js).
// ------------------------------------------------------------
const STOPP = new Set(('och att det som för med har den till är ett en av på om vi du dig din ditt dina '
  + 'oss vår vårt våra eller inte kan ska vill samt från hos men också även alla andra under efter mot '
  + 'över mer mycket bra god goda gärna tjänsten tjänst arbete arbeta arbetet jobb jobbet söker sökande '
  + 'vara blir får sig sin sina sitt där här denna detta dessa när hur vad varje inom genom bland både '
  + 'per helt bör måste minst dem deras någon något några kommer finns jobba arbetar ansökan uppdrag '
  + 'roll rollen hej mvh vänliga hälsningar the and with for').split(/\s+/));

const ord = (t) => String(t || '').toLowerCase().match(/[a-zåäöéü0-9+#]{2,}/g) || [];
// Swedish piles endings on (truck, truckkort, truckkörning), so words
// are compared by their first five letters, or all of a short one.
const rot = (w) => (w.length > 5 ? w.slice(0, 5) : w);

// The words of `annons` (as written there) whose start the letter shares.
export function annonsordIBrevet(brev, annons) {
  const rötter = new Set(ord(brev).filter((w) => w.length >= 4 && !STOPP.has(w)).map(rot));
  if (!rötter.size) return [];
  const ut = new Set();
  for (const w of ord(annons)) {
    if (w.length >= 4 && !STOPP.has(w) && rötter.has(rot(w))) ut.add(w);
  }
  return [...ut];
}
