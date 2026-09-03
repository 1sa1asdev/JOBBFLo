import { pool } from './db.js';
import { llmJson } from './llm.js';
import { ensureLetterShape } from './letters.js';

// ------------------------------------------------------------
// The campaign letter: ONE letter, written by the user and the AI
// together, sent to every ad that matches the campaign's rules.
//
// This is deliberately different from src/letters.js, which tailors
// a letter to one specific ad. A campaign letter has to work for a
// whole category of ads, so it argues from the candidate's side
// rather than answering any single job description — and the user
// reads it before it is ever sent.
// ------------------------------------------------------------

// ------------------------------------------------------------
// A campaign letter is a COLD PITCH, not a tailored application.
// It goes to employers the letter knows nothing about, so faking
// familiarity ("er roll som X hos Y") reads worse than simply being
// direct. What carries a cold email is a sharp intention and a
// concrete pitch: who you are, what you can do, what you want.
// ------------------------------------------------------------

const CAMPAIGN_SYSTEM = `Du skriver ETT kallt mejl som skickas till flera arbetsgivare.

Det här är INTE en ansökan på en specifik annons. Mottagaren vet inget om
kandidaten, och brevet vet inget om mottagaren. Det som avgör om ett kallt
mejl fungerar är tydlig avsikt och en konkret pitch — inte artighetsfraser.

STRUKTUR:
  Ämnesrad: vem du är + vad du söker, på en rad. Konkret, inget "Ansökan".
    Bra: "Fullstackutvecklare (React/Node) söker roll i Stockholm"
    Dåligt: "Ansökan om anställning"
  Hej,
  <stycke 1: säg direkt varför du hör av dig och vad du söker>
  <stycke 2: det starkaste konkreta du har — projekt, teknik, vad du byggt>
  <stycke 3: kort avslut med en tydlig fråga: vill de prata?>
  Vänliga hälsningar,
  <namn>

REGLER:
- 120–200 ord. Kortare än en vanlig ansökan — det här är ett kallt mejl.
- Skriv ALDRIG mejladress, telefonnummer eller länkar. Appen lägger till
  kontaktuppgifterna automatiskt efter namnet, hämtade från profilen —
  de i CV:t kan vara gamla, och brevet skickas från profilens adress.
- Påstå ALDRIG något om mottagaren, deras produkt, kultur eller behov.
  Du vet inte vilka de är. Skriv inte "ert team", "er resa", "just er".
- Inga floskler: "passionerad", "driven", "brinner för", "spännande möjlighet",
  "övertygad om att mina färdigheter".
- Konkret framför adjektiv: teknik, projekt, vad som faktiskt byggts.
- Ljug aldrig. Bara sådant som har stöd i CV:t.
- Skriv ut allt. Inga platshållare, inga hakparenteser, inget att fylla i.

Svara ENDAST med JSON, inga kodstaket:
{"subject":"ämnesraden","body":"brevet med \\n\\n mellan stycken","change_note":"en mening om vad du gjorde"}`;

async function context(searchId) {
  const { rows: [s] } = await pool.query(
    `SELECT s.*, COALESCE(s.cv_text, p.cv_text) AS cv_text,
            p.name, p.email, p.phone, p.about_text, p.tone_text, p.id AS profile_id
     FROM searches s JOIN profile p ON p.id = s.profile_id
     WHERE s.id = $1 AND s.deleted_at IS NULL`, [searchId]
  );
  if (!s) throw new Error(`no search ${searchId}`);
  if (!s.cv_text?.trim()) throw new Error('Inget CV inlagt — ladda upp ett CV först.');

  const { rows: projects } = await pool.query(
    `SELECT name, summary, tech FROM projects WHERE profile_id = $1 AND is_active`, [s.profile_id]
  );

  // a couple of real matching ads, so the letter is aimed at the
  // kind of role the rules actually select rather than at a guess
  const { rows: sample } = await pool.query(
    `SELECT a.title, a.employer, left(a.description, 900) AS snippet
     FROM search_results r JOIN ads a ON a.id = r.ad_id
     WHERE r.search_id = $1 AND r.score >= $2 AND a.apply_email IS NOT NULL
     ORDER BY r.score DESC LIMIT 3`,
    [searchId, s.auto_apply_min_score]
  );

  return { s, projects, sample };
}

function userPrompt({ s, projects, sample }) {
  return `## KANDIDAT
${s.name}
${s.about_text || ''}

## TON
${s.tone_text || '(ingen preferens)'}

## CV
${s.cv_text}

## PROJEKT
${projects.map((p) => `- ${p.name} (${(p.tech || []).join(', ')}): ${p.summary}`).join('\n') || '(inga)'}

## KAMPANJENS REGLER (vilka annonser brevet går till)
${s.criteria_text}

## EXEMPEL PÅ ANNONSER SOM MATCHAR REGLERNA
${sample.map((a) => `- ${a.title} — ${a.employer}\n  ${a.snippet.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') || '(inga ännu)'}`;
}

// ------------------------------------------------------------
// First draft, or a revision turn from the chat.
// ------------------------------------------------------------
export async function writeCampaignLetter(searchId, instruction = null) {
  const ctx = await context(searchId);
  const messages = [{ role: 'user', content: userPrompt(ctx) }];

  if (instruction) {
    messages.push({
      role: 'assistant',
      content: JSON.stringify({ subject: ctx.s.campaign_subject, body: ctx.s.campaign_letter }),
    });
    messages.push({
      role: 'user',
      content: `Revidera brevet enligt: ${instruction}\nSvara med samma JSON-format, inklusive "change_note".`,
    });
    await pool.query(
      `INSERT INTO campaign_messages (search_id, role, content) VALUES ($1,'user',$2)`,
      [searchId, instruction]
    );
  }

  const draft = await llmJson({ tier: 'write', maxTokens: 2000, system: CAMPAIGN_SYSTEM, messages });
  // ctx.s carries the profile's name/email/phone: the SELECT lists them
  // after s.*, so they win over the search's own `name` column. Passing
  // the whole row is what gets the contact line onto a cold email, where
  // it matters most — the recipient has no other way to reach back.
  draft.body = ensureLetterShape(draft.body, ctx.s);

  // changing the letter withdraws approval — the user must read it again
  await pool.query(
    `UPDATE searches SET campaign_subject = $2, campaign_letter = $3,
       campaign_letter_approved_at = NULL WHERE id = $1`,
    [searchId, draft.subject || 'Söker roll', draft.body]
  );
  await pool.query(
    `INSERT INTO campaign_messages (search_id, role, content) VALUES ($1,'assistant',$2)`,
    [searchId, draft.change_note || 'Brevet är uppdaterat.']
  );

  return { subject: draft.subject, body: draft.body, change_note: draft.change_note };
}

// The letter goes out exactly as approved — a cold pitch needs no
// per-employer substitution, and not doing any is what makes "what
// you read is what they receive" literally true.
export function renderCampaignLetter(template) {
  return String(template || '').trim();
}

// what the user is actually approving, shown filled in for a real ad
export async function previewCampaign(searchId) {
  const { rows: [s] } = await pool.query(
    `SELECT campaign_subject, campaign_letter, campaign_letter_approved_at,
            auto_apply_min_score FROM searches WHERE id = $1`, [searchId]
  );
  if (!s?.campaign_letter) return { letter: null };

  const { rows: [ad] } = await pool.query(
    `SELECT a.title, a.employer, a.municipality, a.apply_email, r.score
     FROM search_results r JOIN ads a ON a.id = r.ad_id
     WHERE r.search_id = $1 AND r.score >= $2 AND a.apply_email IS NOT NULL
       AND r.application_status IS NULL
     ORDER BY r.score DESC LIMIT 1`,
    [searchId, s.auto_apply_min_score]
  );

  return {
    letter: { subject: s.campaign_subject, body: s.campaign_letter },
    approved_at: s.campaign_letter_approved_at,
    example: ad ? {
      ad,
      subject: renderCampaignLetter(s.campaign_subject),
      body: renderCampaignLetter(s.campaign_letter),
    } : null,
  };
}

export async function approveCampaignLetter(searchId, approved) {
  const { rows: [s] } = await pool.query(
    `UPDATE searches SET campaign_letter_approved_at = $2 WHERE id = $1 RETURNING campaign_letter_approved_at`,
    [searchId, approved ? new Date() : null]
  );
  return s;
}

export async function campaignMessages(searchId) {
  const { rows } = await pool.query(
    `SELECT role, content, created_at FROM campaign_messages
     WHERE search_id = $1 ORDER BY created_at`, [searchId]
  );
  return rows;
}
