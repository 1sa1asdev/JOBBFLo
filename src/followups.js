import { pool } from './db.js';
import { llmText } from './llm.js';

// ------------------------------------------------------------
// Follow-up nudges. Scheduled follow-ups schedule a DRAFT —
// this file never sends anything. The draft lands as a
// suggested_replies row (kind='followup') for the user to
// approve in the inbox.
// ------------------------------------------------------------

const FOLLOWUP_SYSTEM = `Du skriver ett kort uppföljningsmejl för en jobbsökande, på svenska.

Regler:
- 3-4 meningar max. Artigt men inte undergivet.
- Referera till när ansökan skickades och vilken tjänst det gällde.
- Bekräfta fortsatt intresse, erbjud samtal.
- Inga floskler. Avsluta med "Vänliga hälsningar," och kandidatens förnamn.

Svara med enbart brödtexten.`;

export async function checkFollowups() {
  // due = followup enabled, still unanswered, past (deadline|sent_at) + N days,
  // not already nudged, and no pending followup draft
  const { rows: due } = await pool.query(
    `SELECT a.id, a.sent_at, a.followup_days, ads.title, ads.employer, ads.deadline
     FROM applications a
     JOIN ads ON ads.id = a.ad_id
     WHERE a.status = 'sent'
       AND a.followup_enabled
       AND a.followup_sent_at IS NULL
       AND COALESCE(ads.deadline::timestamptz, a.sent_at) + (a.followup_days || ' days')::interval < now()
       AND NOT EXISTS (
         SELECT 1 FROM suggested_replies sr
         WHERE sr.application_id = a.id AND sr.kind = 'followup' AND NOT sr.dismissed
       )`
  );

  const { rows: [profile] } = await pool.query(`SELECT name FROM profile LIMIT 1`);

  for (const app of due) {
    try {
      const body = await llmText({
        tier: 'write',
        maxTokens: 500,
        system: FOLLOWUP_SYSTEM,
        messages: [{
          role: 'user',
          content: `Kandidat: ${profile?.name}\nTjänst: ${app.title} hos ${app.employer}\nAnsökan skickad: ${new Date(app.sent_at).toLocaleDateString('sv-SE')}\nSista ansökningsdag var: ${app.deadline || 'okänd'}`,
        }],
      });
      await pool.query(
        `INSERT INTO suggested_replies (application_id, body, kind) VALUES ($1, $2, 'followup')`,
        [app.id, body.trim()]
      );
      console.log(`  followup draft: ${app.title} — ${app.employer}`);
    } catch (err) {
      console.error(`  followup ${app.id}: ${err.message}`);
    }
  }
  return due.length;
}
