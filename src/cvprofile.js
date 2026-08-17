import { pool } from './db.js';
import { llmJson } from './llm.js';
import { verifyQuotes } from './score.js';

// ------------------------------------------------------------
// Read the CV once, properly, and keep the result.
//
// Before this, the raw CV rode along in every scoring call and every
// letter call, and the model re-derived what it meant each time. That
// is a thousand disposable inferences by the cheapest model in the
// chain, when the same work done once by the best model costs a
// fraction of a cent and can be reviewed by the person it describes.
//
// The `evidence` field on every fact is the load-bearing part. It must
// appear verbatim in the CV, exactly like the ad quotes in
// match_results (CLAUDE.md #5) — that is what makes this checkable
// instead of merely trusted, and what gives a letter's claims about
// the candidate something to be verified against.
// ------------------------------------------------------------

const PROFILE_SYSTEM = `Du läser ett CV och extraherar vad kandidaten faktiskt kan, en gång, noggrant.

Detta blir underlaget för ALLA framtida bedömningar och brev. Är det fel här blir allt nedströms fel.

REGLER
- "evidence" MÅSTE vara ETT SAMMANHÄNGANDE ordagrant utdrag ur CV:t, max 20 ord.
  Klipp ALDRIG ihop delar med "..." — "X ... Y" är inget citat och underkänns.
  Radbrytningar i CV:t spelar ingen roll, men orden måste stå i följd.
  Kan du inte hitta ett sammanhängande stycke som belägger fakta: utelämna det.
- Varje påstående om kandidaten måste ha stöd i texten. Överdriv inte: en praktikperiod är en praktikperiod, inte "ledde utvecklingen".
- implicit_skills är färdigheter CV:t VISAR men inte namnger. Ett C++-plugin till en flygsimulator visar realtidsprogrammering och hårdvaruintegration även om orden inte står där. Var konservativ — bara det texten verkligen belägger.
- Skriv på svenska, utom tekniknamn som behåller sin form (C#, React, .NET).
- Är något osäkert: utelämna det hellre än att gissa.

Svara ENDAST med JSON, inga kodstaket:
{
  "headline": "en rad som beskriver kandidaten",
  "seniority": "student | junior | mid | senior",
  "years_experience": tal eller null,
  "languages": [{"name": "Svenska", "level": "modersmål"}],
  "skills": [{"name": "C#", "strength": "stark|god|grundläggande", "evidence": "ordagrant ur CV:t"}],
  "implicit_skills": [{"name": "realtidsprogrammering", "why": "kort motivering", "evidence": "ordagrant ur CV:t"}],
  "domains": [{"name": "flygsimulering", "evidence": "ordagrant ur CV:t"}],
  "education": [{"what": "…", "where": "…", "evidence": "ordagrant ur CV:t"}],
  "constraints": ["t.ex. studerar parallellt, bunden till Stockholm — bara om CV:t säger det"],
  "gaps": ["vad en arbetsgivare troligen saknar, kort"]
}`;

export async function buildCvProfile(cvText) {
  if (!cvText?.trim()) throw new Error('inget CV att läsa');

  let usedModel = null;
  const profile = await llmJson({
    onModel: (m) => { usedModel = m; },
    // 'smart' is the best tier configured. This runs once per upload,
    // so the most capable model available is affordable here even when
    // it would be ruinous on the per-ad path.
    tier: 'smart',
    maxTokens: 3000,
    system: PROFILE_SYSTEM,
    messages: [{ role: 'user', content: cvText }],
  });

  // Same invariant as the ad quotes: mark what is actually verbatim so
  // the UI can flag anything the model paraphrased or invented.
  for (const key of ['skills', 'implicit_skills', 'domains', 'education']) {
    profile[key] = verifyQuotes(
      (profile[key] || []).map((f) => ({ ...f, quote: f.evidence })),
      cvText
    ).map(({ quote, ...f }) => f);
  }
  profile.__model = usedModel;
  return profile;
}

// ------------------------------------------------------------
// Render the profile for a prompt. This is what replaces the raw CV
// in the scoring call: the same facts, structured, and about a third
// the tokens — so every ad judged is both cheaper and judged against
// a fixed reading rather than a fresh one.
// ------------------------------------------------------------
export function renderCvProfile(p) {
  if (!p) return null;
  const line = (f) => `${f.name}${f.strength ? ` (${f.strength})` : ''}`;
  const parts = [
    p.headline && `## KANDIDAT\n${p.headline}${p.seniority ? ` — ${p.seniority}` : ''}${p.years_experience ? `, ~${p.years_experience} års erfarenhet` : ''}`,
    p.skills?.length && `## KOMPETENSER\n${p.skills.map(line).join(', ')}`,
    p.implicit_skills?.length && `## VISAR OCKSÅ\n${p.implicit_skills.map((f) => `${f.name} (${f.why})`).join(', ')}`,
    p.domains?.length && `## DOMÄNER\n${p.domains.map((d) => d.name).join(', ')}`,
    p.education?.length && `## UTBILDNING\n${p.education.map((e) => `${e.what}, ${e.where}`).join('; ')}`,
    p.languages?.length && `## SPRÅK\n${p.languages.map((l) => `${l.name} (${l.level})`).join(', ')}`,
    p.constraints?.length && `## FÖRUTSÄTTNINGAR\n${p.constraints.join('; ')}`,
    p.gaps?.length && `## KÄNDA LUCKOR\n${p.gaps.join('; ')}`,
  ].filter(Boolean);
  return parts.join('\n\n');
}

// Build and store. searchId targets a search's tailored CV; omit it
// for the base profile.
export async function refreshCvProfile({ searchId = null } = {}) {
  const table = searchId ? 'searches' : 'profile';
  const { rows: [row] } = searchId
    ? await pool.query(`SELECT cv_text FROM searches WHERE id = $1`, [searchId])
    : await pool.query(`SELECT cv_text FROM profile LIMIT 1`);

  if (!row?.cv_text?.trim()) return null;

  const profile = await buildCvProfile(row.cv_text);
  const model = profile.__model || null;
  delete profile.__model;

  if (searchId) {
    await pool.query(
      `UPDATE searches SET cv_profile = $2, cv_profile_at = now(), cv_profile_model = $3
       WHERE id = $1`, [searchId, JSON.stringify(profile), model]
    );
  } else {
    await pool.query(
      `UPDATE profile SET cv_profile = $1, cv_profile_at = now(), cv_profile_model = $2`,
      [JSON.stringify(profile), model]
    );
  }
  const facts = ['skills', 'implicit_skills', 'domains', 'education']
    .reduce((n, k) => n + (profile[k]?.length || 0), 0);
  const unverified = ['skills', 'implicit_skills', 'domains', 'education']
    .reduce((n, k) => n + (profile[k] || []).filter((f) => !f.verbatim).length, 0);
  console.log(`CV-profil byggd (${table}): ${facts} fakta, ${unverified} utan ordagrant belägg`);
  return profile;
}
