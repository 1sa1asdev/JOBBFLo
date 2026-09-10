import { pool } from './db.js';
import { llmJson } from './llm.js';
import { verifyQuotes } from './score.js';

// ------------------------------------------------------------
// Does the letter claim things the CV cannot back?
//
// A letter written by a model, sent by a campaign, to a stranger, with
// nobody reading it in between. Three of those were already true; the
// fourth arrived when confirmation was dropped from the address flow.
// So the last reader of a cover letter is now the employer, and a
// sentence like "jag har fem års erfarenhet av Kubernetes" reaches them
// whether or not it is true.
//
// This is the same invariant the scorer already lives under, pointed
// the other way. There, quotes from the AD must be verbatim so the UI
// can highlight them. Here, claims about the CANDIDATE must be
// traceable to the CV — and the model must quote the letter's own
// sentence verbatim, so a flag can be shown against the actual text
// rather than against a paraphrase of it.
//
// What counts as a claim: something checkable about the candidate.
// Experience, years, tools, education, employers, results. Not
// enthusiasm, not intent, not "jag skulle passa bra" — those are
// opinions, and a cover letter is allowed to hold them.
// ------------------------------------------------------------
const SYSTEM = `Du granskar ett personligt brev mot en kandidats CV.

Din enda uppgift: hitta PÅSTÅENDEN om kandidaten som CV:t inte styrker.

Ett påstående är något kontrollerbart — erfarenhet, antal år, verktyg,
utbildning, arbetsgivare, resultat, roller. Åsikter och avsikter är inte
påståenden: "jag brinner för", "jag skulle passa bra", "jag vill lära
mig" ska aldrig flaggas.

Bedöm varje påstående mot CV:t:
- "styrkt": CV:t säger detta, eller något som direkt innebär det.
- "ostyrkt": CV:t säger det inte. Även om det låter rimligt.
- "motsagt": CV:t säger något annat (fel antal år, fel roll, fel verktyg).

Var strikt med siffror. "Tre års erfarenhet" är ostyrkt om CV:t inte
visar tre år. Var generös med omformuleringar: CV:t "React, Node" styrker
"erfarenhet av React och Node".

Svara med JSON:
{"claims":[{"quote":"ordagrann mening ur brevet","verdict":"styrkt|ostyrkt|motsagt","why":"kort skäl"}]}

quote MÅSTE vara kopierad ordagrant ur brevet, max 20 ord. Ta bara med
påståenden som är ostyrkta eller motsagda — styrkta behöver inte
redovisas. Hittar du inga, svara {"claims":[]}.`;

export async function checkClaims({ letter, cvText, cvProfile = null }) {
  if (!letter?.trim() || !cvText?.trim()) return { claims: [], checked: false };

  const r = await llmJson({
    // The cheap tier. This runs once per letter on a path that sends
    // a hundred a day, and the task is comparison rather than
    // judgement — it has both texts in front of it.
    tier: 'fast',
    maxTokens: 1200,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `CV:\n${cvText.slice(0, 12000)}\n\n`
        + (cvProfile ? `Strukturerad läsning av CV:t:\n${JSON.stringify(cvProfile).slice(0, 4000)}\n\n` : '')
        + `BREVET:\n${letter}`,
    }],
  });

  // A flag against a sentence that is not in the letter cannot be shown
  // to the user and cannot be acted on — same rule as the ad quotes,
  // and for the same reason.
  const claims = verifyQuotes(r?.claims || [], letter)
    .filter((c) => c.verbatim && c.verdict !== 'styrkt');

  return {
    claims,
    checked: true,
    unsupported: claims.filter((c) => c.verdict === 'ostyrkt').length,
    contradicted: claims.filter((c) => c.verdict === 'motsagt').length,
  };
}

// Checks the letter stored on an application, and remembers the result
// so the UI does not pay for the same check every time it renders.
export async function checkApplicationClaims(applicationId) {
  const { rows: [app] } = await pool.query(
    `SELECT a.id, a.letter_text, a.letter_version,
            COALESCE(s.cv_text, p.cv_text)       AS cv_text,
            COALESCE(s.cv_profile, p.cv_profile) AS cv_profile
     FROM applications a
     JOIN profile p ON p.id = a.profile_id
     LEFT JOIN searches s ON s.id = a.origin_search_id
     WHERE a.id = $1`, [applicationId]
  );
  if (!app?.letter_text) return { claims: [], checked: false };

  const r = await checkClaims({
    letter: app.letter_text, cvText: app.cv_text, cvProfile: app.cv_profile,
  });

  await pool.query(
    `UPDATE applications
       SET claim_check = $2::jsonb, claim_checked_version = $3
     WHERE id = $1`,
    [applicationId, JSON.stringify(r), app.letter_version]
  );
  return r;
}
