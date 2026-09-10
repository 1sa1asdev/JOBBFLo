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

Ett påstående är något kontrollerbart om det som REDAN HÄNT — erfarenhet,
antal år, verktyg kandidaten använt, utbildning, arbetsgivare, resultat,
roller.

Detta är INTE påståenden och ska aldrig flaggas:
- åsikter och avsikter: "jag brinner för", "jag skulle passa bra"
- vad kandidaten söker eller vill: "jag söker en LIA-plats", "jag vill lära mig"
- datum och perioder kandidaten är TILLGÄNGLIG: "mellan januari och maj"
  är önskemål om framtiden, inte en uppgift ur CV:t
- egna projekt och fritidsbyggen som brevet självt presenterar som egna
  ("jag bygger just nu X") — CV:t behöver inte känna till dem
- kontaktuppgifter, hälsningar, artighetsfraser

Bedöm varje påstående mot CV:t:
- "styrkt": CV:t säger detta, eller något som direkt innebär det.
- "ostyrkt": CV:t säger det inte. Även om det låter rimligt.
- "motsagt": CV:t säger något OFÖRENLIGT — fel arbetsgivare, fel
  rolltitel, färre år än brevet påstår. Att CV:t är tyst om något är
  ostyrkt, aldrig motsagt. Reservera "motsagt" för när de två texterna
  inte kan vara sanna samtidigt.

Var strikt med siffror. "Tre års erfarenhet" är ostyrkt om CV:t inte
visar tre år. Var generös med omformuleringar: CV:t "React, Node" styrker
"erfarenhet av React och Node".

En uppräkning där de flesta finns i CV:t men något saknas är ostyrkt,
inte motsagt — flagga den och citera hela uppräkningen.

Svara med JSON:
{"claims":[{"quote":"ordagrann text ur BREVET","verdict":"styrkt|ostyrkt|motsagt","cv_quote":"ordagrann text ur CV:T som styrker det, eller null","why":"kort skäl"}]}

cv_quote är beviset. Är påståendet styrkt MÅSTE du klistra in den rad ur
CV:t som styrker det, ordagrant och på CV:ts eget språk. Kan du inte hitta
en sådan rad är påståendet ostyrkt. Detta gäller varje påstående du tar
med — ta med både styrkta och ostyrkta.

CV:T KAN VARA PÅ ETT ANNAT SPRÅK ÄN BREVET. Ett CV på engelska styrker
ett brev på svenska: "Substitute Care Assistant, Åtvidabergs Kommun"
styrker "substitutvårdare i Åtvidabergs kommun", "Web Developer" styrker
"webbutvecklare". Översätt innan du dömer — annars flaggar du sant
innehåll bara för att orden ser olika ut.

Innan du flaggar något som ostyrkt: läs igenom HELA CV:t en gång till
och leta efter arbetsgivaren, verktyget eller rollen, på BÅDA språken.
CV:t är kort. Är du osäker är svaret "styrkt" — en falsk flagga stoppar
ett brev som var korrekt, vilket är värre än att missa en.

quote MÅSTE vara kopierad ordagrant ur brevet, max 20 ord. Ta bara med
påståenden som är ostyrkta eller motsagda — styrkta behöver inte
redovisas. Hittar du inga, svara {"claims":[]}.`;

export async function checkClaims({ letter, cvText, cvProfile = null }) {
  if (!letter?.trim() || !cvText?.trim()) return { claims: [], checked: false };

  const r = await llmJson({
    // Measured, not assumed. On 'fast' this flagged "substitut-
    // vårdbiträde i Åtvidabergs kommun" as unsupported against a CV
    // that names Åtvidaberg — six letters produced 21 flags, most of
    // them wrong. A gate that fires on false positives stops a working
    // campaign, which is worse than the problem it guards against, so
    // this runs on the scoring tier instead.
    tier: 'bulk',
    maxTokens: 1200,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `CV:\n${cvText.slice(0, 12000)}\n\n`
        + (cvProfile ? `Strukturerad läsning av CV:t:\n${JSON.stringify(cvProfile).slice(0, 4000)}\n\n` : '')
        + `BREVET:\n${letter}`,
    }],
  });

  // Two verifications, and the second is the one that matters.
  //
  // Prompt tuning could not stop this model flagging "Substitute Care
  // Assistant på Åtvidabergs Kommun" against a CV containing exactly
  // that line — four rounds of instructions, including telling it the
  // CV may be in another language, and it kept saying unsupported. So
  // its verdict is no longer trusted: it must paste the CV line that
  // supports the claim, and THAT is checked here, deterministically.
  //
  // Found in the CV → supported, whatever the model called it. Not
  // found → the flag stands. A model that hallucinates evidence gets
  // caught by the same substring test the ad quotes already use, and a
  // model that overlooks evidence can no longer veto a true sentence.
  const inLetter = verifyQuotes(r?.claims || [], letter).filter((c) => c.verbatim);
  const withProof = verifyQuotes(
    inLetter.map((c) => ({ ...c, quote: c.cv_quote || '' })), cvText,
  ).map((c, i) => ({ ...inLetter[i], proven: c.verbatim }));

  // A word-novelty backstop was tried here and removed. The idea was
  // that a flag must name something concrete the CV lacks — which works
  // in principle and collapses in this case, because the CV is in
  // English and the letters are in Swedish. Nearly every Swedish word
  // is "absent from the CV", so the filter passed everything and the
  // count went from 20 flags to 34. Recorded because it is the obvious
  // next idea and it does not work here.
  const claims = withProof.filter((c) => !c.proven && c.verdict !== 'styrkt');

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
