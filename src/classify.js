import { pool } from './db.js';
import { anthropic, MODEL_FAST, MODEL_SMART, jsonOf, textOf } from './llm.js';

// ------------------------------------------------------------
// Inbound reply handling: classify fast (Haiku, ~1s, so the
// status badge + notification can go out immediately), then
// draft a suggested reply (Sonnet) after.
// ------------------------------------------------------------

const CLASSIFY_SYSTEM = `Du klassificerar svar från arbetsgivare på jobbansökningar.

Svara ENDAST med JSON, inga kodstaket:
{"status": "replied" | "interview" | "rejected", "summary": "en mening på svenska"}

- "interview": de vill boka samtal/intervju/träff, eller ber om tider.
- "rejected": tack-men-nej, gått vidare med andra kandidater.
- "replied": allt annat (bekräftelse, följdfråga, begäran om komplettering).`;

export async function classifyReply(emailBody, { subject = '' } = {}) {
  const res = await anthropic.messages.create({
    model: MODEL_FAST,
    max_tokens: 300,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: 'user', content: `Ämne: ${subject}\n\n${emailBody}` }],
  });
  return jsonOf(res);
}

const REPLY_SYSTEM = `Du skriver utkast till svar på mejl från arbetsgivare, för en jobbsökande, på svenska.

Regler:
- Kort och rakt på sak. Ingen överdriven entusiasm, inga floskler.
- Vid intervjuförfrågan: tacka kort, föreslå konkret tid utifrån det de erbjuder.
- Vid följdfråga: svara på frågan om underlaget räcker, annars be om förtydligande.
- Vid avslag: skriv inget utkast — svara med exakt texten INGET_SVAR.
- Avsluta med "Vänliga hälsningar," och kandidatens förnamn.

Svara med enbart brödtexten (eller INGET_SVAR), ingen JSON.`;

export async function draftReply(applicationId, inboundEmailId) {
  const { rows: [email] } = await pool.query(
    `SELECT * FROM email_messages WHERE id = $1`, [inboundEmailId]
  );
  const { rows: [app] } = await pool.query(
    `SELECT a.*, ads.title, ads.employer FROM applications a
     JOIN ads ON ads.id = a.ad_id WHERE a.id = $1`, [applicationId]
  );
  const { rows: [profile] } = await pool.query(`SELECT name, about_text, tone_text FROM profile LIMIT 1`);
  if (!email || !app) return null;

  const res = await anthropic.messages.create({
    model: MODEL_SMART,
    max_tokens: 1000,
    system: REPLY_SYSTEM,
    messages: [{
      role: 'user',
      content: `## KANDIDAT\n${profile?.name}\n${profile?.about_text || ''}\nTon: ${profile?.tone_text || ''}

## ANSÖKAN
Tjänst: ${app.title} hos ${app.employer}
Skickad: ${app.sent_at}
Brevet du skickade:
${app.letter_text}

## INKOMMET MEJL (svara på detta)
Från: ${email.from_name || email.from_addr}
${email.body_text}`,
    }],
  });

  const body = textOf(res).trim();
  if (!body || body === 'INGET_SVAR') return null;

  const { rows: [suggestion] } = await pool.query(
    `INSERT INTO suggested_replies (application_id, reply_to_id, body, kind)
     VALUES ($1, $2, $3, 'reply') RETURNING *`,
    [applicationId, inboundEmailId, body]
  );
  return suggestion;
}

// ------------------------------------------------------------
// interview prep — generated when status flips to 'interview'.
// ------------------------------------------------------------
const PREP_SYSTEM = `Du förbereder en kandidat inför en jobbintervju.

Du får annonsen, kandidatens CV och det personliga brev som skickades.

Svara ENDAST med JSON, inga kodstaket:
{
  "questions": ["4-6 troliga intervjufrågor, specifika för annonsen"],
  "claimed_note": "vad kandidaten påstod i brevet och bör kunna backa upp",
  "gaps": ["luckor mellan annonsens krav och CV:t, värda att förbereda"]
}`;

export async function generateInterviewPrep(applicationId) {
  const { rows: [app] } = await pool.query(
    `SELECT a.*, ads.title, ads.employer, ads.description FROM applications a
     JOIN ads ON ads.id = a.ad_id WHERE a.id = $1`, [applicationId]
  );
  const { rows: [profile] } = await pool.query(`SELECT cv_text FROM profile LIMIT 1`);
  if (!app) return null;

  const res = await anthropic.messages.create({
    model: MODEL_SMART,
    max_tokens: 1500,
    system: PREP_SYSTEM,
    messages: [{
      role: 'user',
      content: `## ANNONS\n${app.title} — ${app.employer}\n${app.description}\n\n## CV\n${profile?.cv_text}\n\n## SKICKAT BREV\n${app.letter_text}`,
    }],
  });
  const prep = jsonOf(res);

  const { rows: [row] } = await pool.query(
    `INSERT INTO interview_prep (application_id, questions, claimed_note, gaps)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (application_id) DO UPDATE SET
       questions = EXCLUDED.questions, claimed_note = EXCLUDED.claimed_note, gaps = EXCLUDED.gaps
     RETURNING *`,
    [applicationId, JSON.stringify(prep.questions || []), prep.claimed_note || null,
     JSON.stringify(prep.gaps || [])]
  );
  return row;
}
