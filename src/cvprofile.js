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

const PROFILE_SYSTEM = `Du läser ett CV och extraherar HELA kandidatens bakgrund, en gång, noggrant.

Detta blir underlaget för ALLA framtida bedömningar och brev. Är det fel eller ofullständigt här blir allt nedströms fel.

VIKTIGAST AV ALLT — TA MED ALLT
Kandidaten söker inte nödvändigtvis samma sorts jobb som hen haft. Någon med
IT-utbildning söker extrajobb i vården, i butik eller på restaurang; en
undersköterska söker kontorsjobb. Du vet inte vad hen söker och ska inte gissa.

- Ta med VARJE anställning, praktik, vikariat och uppdrag i "experience" —
  även de som verkar irrelevanta för kandidatens "huvudspår".
- Filtrera ALDRIG bort en erfarenhet för att den ligger utanför det yrkesområde
  CV:t mest handlar om. Två år i äldreomsorg är två års erfarenhet, precis lika
  mycket värd som två år som utvecklare, och kan vara det enda som räknas för
  jobbet kandidaten faktiskt söker.
- "skills" ska täcka alla fält: teknik OCH omvårdnad, service, bemötande,
  språk, körkort, maskiner, kassasystem — vad som än står i CV:t.
- Sätt "field" på varje erfarenhet och kompetens (t.ex. "IT", "vård och omsorg",
  "restaurang", "utbildning") så att inget behöver gissas senare.

REGLER
- "evidence" MÅSTE vara ETT SAMMANHÄNGANDE ordagrant utdrag ur CV:t, max 20 ord.
  Klipp ALDRIG ihop delar med "..." — "X ... Y" är inget citat och underkänns.
  Radbrytningar i CV:t spelar ingen roll, men orden måste stå i följd.
  Kan du inte hitta ett sammanhängande stycke som belägger fakta: utelämna det.
- Varje påstående måste ha stöd i texten. Överdriv inte: en praktikperiod är en
  praktikperiod, inte "ledde utvecklingen".
- implicit_skills är färdigheter CV:t VISAR men inte namnger. Ett C++-plugin till
  en flygsimulator visar realtidsprogrammering; arbete i LSS-boende visar
  dokumentation, tystnadsplikt och bemötande av personer med funktionsnedsättning.
  Var konservativ — bara det texten verkligen belägger.
- Skriv på svenska, utom tekniknamn och egennamn som behåller sin form.
- Gissa ALDRIG vad kandidaten vill jobba med. Profilen beskriver vad hen HAR gjort;
  vad hen SÖKER står någon annanstans och kan vara ett helt annat yrkesområde.
- Är något osäkert: utelämna det hellre än att gissa.

Svara ENDAST med JSON, inga kodstaket:
{
  "headline": "en rad som SAMMANFATTAR HELA bakgrunden, inte en yrkesidentitet. Skriv t.ex. \"Systemutvecklarutbildad, 2 år i vård och omsorg och praktik inom mjukvara\" — INTE \"Full-Stack Developer\". En yrkestitel här får senare bedömningar att anta ett karriärmål kandidaten aldrig uttryckt.",
  "seniority": "student | junior | mid | senior",
  "years_experience": tal eller null,
  "languages": [{"name": "Svenska", "level": "modersmål"}],
  "experience": [{
    "role": "Substitute Care Assistant",
    "employer": "Åtvidabergs Kommun",
    "period": "Jun 2023 – Jul 2025",
    "field": "vård och omsorg",
    "what": "en mening om vad hen gjorde",
    "skills": ["personcentrerat stöd", "LSS"],
    "evidence": "ordagrant ur CV:t"
  }],
  "skills": [{"name": "C#", "field": "IT", "strength": "stark|god|grundläggande", "evidence": "ordagrant ur CV:t"}],
  "implicit_skills": [{"name": "realtidsprogrammering", "field": "IT", "why": "kort motivering", "evidence": "ordagrant ur CV:t"}],
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
    // The schema grew an experience array; 3000 truncated mid-JSON and
    // surfaced as "tomt svar (finish=length)". This runs once per CV,
    // so headroom costs nothing.
    maxTokens: 6000,
    system: PROFILE_SYSTEM,
    messages: [{ role: 'user', content: cvText }],
  });

  // Same invariant as the ad quotes: mark what is actually verbatim so
  // the UI can flag anything the model paraphrased or invented.
  for (const key of ['experience', 'skills', 'implicit_skills', 'domains', 'education']) {
    profile[key] = verifyQuotes(
      (profile[key] || []).map((f) => ({ ...f, quote: f.evidence })),
      cvText
    ).map(({ quote, ...f }) => f);
  }
  profile.__model = usedModel;
  return profile;
}

// ------------------------------------------------------------
// Render the profile for a prompt. This replaces the raw CV in the
// scoring call.
//
// It is NOT a compression: carrying every job across every field makes
// it about the same size as the CV it replaces. The win is that the
// reading is fixed and complete — two ads are judged against the same
// candidate, and a care ad meets care skills instead of having to dig
// one line out of a wall of tech prose. Measured on a personlig
// assistent ad: 5 with the raw CV, 30 with this.
// ------------------------------------------------------------
export function renderCvProfile(p) {
  if (!p) return null;
  const tag = (f) => `${f.name}${f.strength ? ` (${f.strength})` : ''}`;

  // Skills grouped by field, so a care job's requirements meet care
  // skills instead of having to be inferred out of a wall of C# and
  // React. Nothing is filtered — the model still sees the whole
  // background, because we do not know which part this ad needs.
  const byField = {};
  const seen = new Set();
  // Key on the bare name, not the rendered label: the top-level list
  // carries "C++ (stark)" while a job's skills carry plain "C++", and
  // comparing rendered strings lets the same skill through twice.
  const add = (field, name, label = name) => {
    const key = `${field}|${name}`.toLowerCase().trim();
    if (seen.has(key)) return;
    seen.add(key);
    (byField[field] ||= []).push(label);
  };
  for (const f of p.skills || []) add(f.field || 'övrigt', f.name, tag(f));
  // Skills attached to a job also count. Without this, a CV whose
  // top-level skills list is a tech stack renders as tech-only, and two
  // years of care work shows up as one line under ERFARENHET while
  // KOMPETENSER says C# and React — which is exactly the imbalance that
  // makes a care ad score badly and a care letter hard to write.
  for (const e of p.experience || []) {
    for (const sk of e.skills || []) add(e.field || 'övrigt', sk);
  }

  const parts = [
    p.headline && `## KANDIDAT
${p.headline}${p.seniority ? ` — ${p.seniority}` : ''}${p.years_experience ? `, ~${p.years_experience} års erfarenhet` : ''}`,

    // Experience first and in full: this is the part a non-tech ad is
    // matched against, and the part a letter needs to draw on.
    p.experience?.length && `## ERFARENHET
${p.experience.map((e) =>
      `- ${e.role}${e.employer ? `, ${e.employer}` : ''}${e.period ? ` (${e.period})` : ''}`
      + `${e.field ? ` [${e.field}]` : ''}`
      + `${e.what ? `
  ${e.what}` : ''}`
      + `${e.skills?.length ? `
  Färdigheter: ${e.skills.join(', ')}` : ''}`
    ).join('\n')}`,

    Object.keys(byField).length && `## KOMPETENSER
${Object.entries(byField)
      .map(([field, list]) => `- ${field}: ${list.join(', ')}`).join('\n')}`,

    p.implicit_skills?.length && `## VISAR OCKSÅ
${p.implicit_skills
      .map((f) => `${f.name}${f.field ? ` [${f.field}]` : ''} (${f.why})`).join(', ')}`,
    p.domains?.length && `## DOMÄNER
${p.domains.map((d) => d.name).join(', ')}`,
    p.education?.length && `## UTBILDNING
${p.education.map((e) => `${e.what}, ${e.where}`).join('; ')}`,
    p.languages?.length && `## SPRÅK
${p.languages.map((l) => `${l.name} (${l.level})`).join(', ')}`,
    p.constraints?.length && `## FÖRUTSÄTTNINGAR
${p.constraints.join('; ')}`,
    p.gaps?.length && `## KÄNDA LUCKOR
${p.gaps.join('; ')}`,
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
  const KEYS = ['experience', 'skills', 'implicit_skills', 'domains', 'education'];
  const facts = KEYS.reduce((n, k) => n + (profile[k]?.length || 0), 0);
  const unverified = KEYS.reduce(
    (n, k) => n + (profile[k] || []).filter((f) => !f.verbatim).length, 0);
  const fields = [...new Set((profile.experience || []).map((e) => e.field).filter(Boolean))];
  console.log(`  yrkesområden i bakgrunden: ${fields.join(', ') || '—'}`);
  console.log(`CV-profil byggd (${table}): ${facts} fakta, ${unverified} utan ordagrant belägg`);
  return profile;
}
