import { pool } from './db.js';
import { anthropic, MODEL_SMART, jsonOf } from './llm.js';

// ------------------------------------------------------------
// Cover letters. Always drafts — nothing here sends anything.
// The generator gets the match_result quotes so claims in the
// letter can be linked back to the requirement they answer.
// ------------------------------------------------------------

const LETTER_SYSTEM = `Du skriver personliga brev för en jobbsökande, på svenska.

Regler:
- Kort: 150–250 ord. Inga floskler ("passionerad", "driven", "brinner för").
- Konkret: nämn projekt och erfarenheter, inte adjektiv.
- Utgå från kandidatens ton-instruktioner om sådana finns.
- Svara på det annonsen faktiskt efterfrågar — använd de citerade kraven.
- Ljug aldrig. Påstå inget som inte har stöd i CV:t eller projekten.
- Avsluta med "Vänliga hälsningar," och kandidatens namn.

Svara ENDAST med JSON, inga kodstaket:
{"subject": "Ansökan: <tjänstetitel>", "body": "brevet med \\n\\n mellan stycken", "change_note": "en mening om vad du gjorde"}`;

function letterContext({ profile, projects, ad, match }) {
  const projectList = projects
    .map((p) => `- ${p.name} (${(p.tech || []).join(', ')}): ${p.summary}`)
    .join('\n');
  const matched = (match?.matched || [])
    .map((m) => `- "${m.quote}" — ${m.why}`)
    .join('\n');

  return `## KANDIDAT
Namn: ${profile.name}
${profile.about_text || ''}

## TON
${profile.tone_text || '(ingen preferens angiven)'}

## CV
${profile.cv_text}

## PROJEKT
${projectList || '(inga)'}

## ANNONS
Titel: ${ad.title}
Arbetsgivare: ${ad.employer}
Ort: ${ad.municipality || '—'}

${ad.description}

## KRAV SOM MATCHADE (citera-bara belägg ur annonsen)
${matched || '(inga sparade)'}
${match?.lead_project_name ? `\n## LYFT FRAM I FÖRSTA HAND\nProjektet "${match.lead_project_name}"` : ''}`;
}

async function loadContext(adId) {
  const { rows: [profile] } = await pool.query(`SELECT * FROM profile LIMIT 1`);
  if (!profile) throw new Error('no profile — run db:seed');

  const { rows: [ad] } = await pool.query(`SELECT * FROM ads WHERE id = $1`, [adId]);
  if (!ad) throw new Error(`no ad ${adId}`);

  const { rows: projects } = await pool.query(
    `SELECT * FROM projects WHERE profile_id = $1 AND is_active`, [profile.id]
  );

  // best match_result for this ad, any search — for quotes + lead project
  const { rows: [match] } = await pool.query(
    `SELECT m.*, p.name AS lead_project_name
     FROM match_results m LEFT JOIN projects p ON p.id = m.lead_project_id
     WHERE m.ad_id = $1 ORDER BY m.score DESC LIMIT 1`, [adId]
  );

  return { profile, projects, ad, match };
}

// ------------------------------------------------------------
// draftLetter: create (or return existing) application + v1.
// UNIQUE(ad_id) guarantees one application per ad, ever.
// ------------------------------------------------------------
export async function draftLetter(adId, { originSearchId = null } = {}) {
  const existing = await pool.query(`SELECT * FROM applications WHERE ad_id = $1`, [adId]);
  if (existing.rows[0]?.letter_text) return existing.rows[0];

  const ctx = await loadContext(adId);

  const res = await anthropic.messages.create({
    model: MODEL_SMART,
    max_tokens: 2000,
    system: LETTER_SYSTEM,
    messages: [{ role: 'user', content: letterContext(ctx) }],
  });
  const draft = jsonOf(res);

  const { rows: [app] } = await pool.query(
    `INSERT INTO applications (ad_id, origin_search_id, status, subject, letter_text, letter_version)
     VALUES ($1, $2, 'drafted', $3, $4, 1)
     ON CONFLICT (ad_id) DO UPDATE SET
       subject = EXCLUDED.subject, letter_text = EXCLUDED.letter_text,
       letter_version = 1, updated_at = now()
     RETURNING *`,
    [adId, originSearchId, draft.subject, draft.body]
  );

  await pool.query(
    `INSERT INTO letter_versions (application_id, version, subject, body, change_note)
     VALUES ($1, 1, $2, $3, $4)
     ON CONFLICT (application_id, version) DO UPDATE SET
       subject = EXCLUDED.subject, body = EXCLUDED.body, change_note = EXCLUDED.change_note`,
    [app.id, draft.subject, draft.body, draft.change_note || 'Första utkastet']
  );

  return app;
}

// ------------------------------------------------------------
// reviseLetter: one turn of the revision chat. New version row
// every time so the UI's version picker / undo works.
// ------------------------------------------------------------
export async function reviseLetter(applicationId, instruction) {
  const { rows: [app] } = await pool.query(
    `SELECT a.*, ads.id AS ad_id FROM applications a JOIN ads ON ads.id = a.ad_id WHERE a.id = $1`,
    [applicationId]
  );
  if (!app) throw new Error(`no application ${applicationId}`);
  if (app.status !== 'drafted') throw new Error('letter is locked — already sent');

  const ctx = await loadContext(app.ad_id);

  const res = await anthropic.messages.create({
    model: MODEL_SMART,
    max_tokens: 2000,
    system: LETTER_SYSTEM,
    messages: [
      { role: 'user', content: letterContext(ctx) },
      { role: 'assistant', content: JSON.stringify({ subject: app.subject, body: app.letter_text }) },
      { role: 'user', content: `Revidera brevet enligt: ${instruction}\nSvara med samma JSON-format, inklusive "change_note".` },
    ],
  });
  const draft = jsonOf(res);
  const version = app.letter_version + 1;

  await pool.query(
    `UPDATE applications SET subject = $2, letter_text = $3, letter_version = $4, updated_at = now()
     WHERE id = $1`,
    [applicationId, draft.subject, draft.body, version]
  );
  await pool.query(
    `INSERT INTO letter_versions (application_id, version, subject, body, change_note)
     VALUES ($1, $2, $3, $4, $5)`,
    [applicationId, version, draft.subject, draft.body, draft.change_note || instruction]
  );

  return { ...app, subject: draft.subject, letter_text: draft.body, letter_version: version, change_note: draft.change_note };
}

// restore an earlier version (undo in the UI)
export async function restoreVersion(applicationId, version) {
  const { rows: [v] } = await pool.query(
    `SELECT * FROM letter_versions WHERE application_id = $1 AND version = $2`,
    [applicationId, version]
  );
  if (!v) throw new Error(`no version ${version}`);
  const { rows: [app] } = await pool.query(
    `UPDATE applications SET subject = $2, letter_text = $3, letter_version = $4, updated_at = now()
     WHERE id = $1 AND status = 'drafted' RETURNING *`,
    [applicationId, v.subject, v.body, v.version]
  );
  return app;
}

// ------------------------------------------------------------
// paragraph reuse check — flags paragraphs nearly identical to
// ones in previously written letters (the "84% identiskt" warn).
// Pure string similarity, no LLM.
// ------------------------------------------------------------
function bigrams(s) {
  const t = s.toLowerCase().replace(/[^a-zåäö0-9 ]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

export async function reuseWarnings(applicationId) {
  const { rows: [app] } = await pool.query(
    `SELECT letter_text FROM applications WHERE id = $1`, [applicationId]
  );
  if (!app?.letter_text) return [];

  const { rows: others } = await pool.query(
    `SELECT a.letter_text, ads.employer, a.sent_at
     FROM applications a JOIN ads ON ads.id = a.ad_id
     WHERE a.id <> $1 AND a.letter_text IS NOT NULL`, [applicationId]
  );

  const warnings = [];
  const paras = app.letter_text.split(/\n\n+/).filter((p) => p.split(' ').length > 8);
  paras.forEach((para, i) => {
    for (const other of others) {
      for (const op of other.letter_text.split(/\n\n+/)) {
        const sim = dice(para, op);
        if (sim > 0.8) {
          warnings.push({
            paragraph: i + 1,
            similarity: Math.round(sim * 100),
            employer: other.employer,
            sent_at: other.sent_at,
          });
          return; // one warning per paragraph is enough
        }
      }
    }
  });
  return warnings;
}
