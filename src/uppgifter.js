// ------------------------------------------------------------
// What an AI call is for. Every call names one (llm_usage.uppgift,
// migration 059), so what a judged ad, a letter or a campaign costs can
// be read off real calls instead of guessed from tiers.
// prove-profile-scope.js fails a call that does not say.
// ------------------------------------------------------------
export const UPPGIFT = Object.freeze({
  LÄSA_KRAV: 'läsa_krav',           // an ad's requirements, read once per (ad, user)
  BEDÖMA: 'bedöma',                 // the checklist: each requirement against the CV
  BREV: 'brev',                     // a cover letter's first draft
  BREV_REVIDERA: 'brev_revidera',   // a letter rewritten on the user's instruction
  BREV_KONTROLL: 'brev_kontroll',   // a letter's claims checked against the CV
  SVAR_KLASSA: 'svar_klassa',       // an employer's reply: interview, rejection, …
  SVAR_UTKAST: 'svar_utkast',       // a draft answer to that reply
  INTERVJU: 'intervju',             // interview preparation
  PÅMINNELSE: 'påminnelse',         // a follow-up nudge (drafted, never sent unread)
  KRITERIER_CHATT: 'kriterier_chatt', // the search chat that shapes criteria
  KRITERIER_TOLKA: 'kriterier_tolka', // criteria text read into filters
  KAMPANJ_CHATT: 'kampanj_chatt',   // the campaign chat
  CV_PROFIL: 'cv_profil',           // the CV read into a profile
  LEAD_TOLKA: 'lead_tolka',         // a pasted job lead read into an ad
  TEST: 'test',                     // "Testa anslutning"
});

export const KÄNDA_UPPGIFTER = new Set(Object.values(UPPGIFT));
