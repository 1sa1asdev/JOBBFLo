import { pool } from './db.js';
import { llmJson } from './llm.js';

// ------------------------------------------------------------
// Cover letters. Always drafts — nothing here sends anything.
// The generator gets the match_result quotes so claims in the
// letter can be linked back to the requirement they answer.
// ------------------------------------------------------------

const LETTER_SYSTEM = `Du skriver personliga brev för en jobbsökande, på svenska.

BREVETS STRUKTUR — följ exakt, annars är brevet oanvändbart:
  Hej,
  <stycke 1: vem du är och vilken roll du söker>
  <stycke 2: konkret projekt/erfarenhet som svarar mot annonsens krav>
  <stycke 3: kort avslutning>
  Vänliga hälsningar,
  <kandidatens namn>

DEN VIKTIGASTE REGELN — läs den innan du skriver något:

Du får ENDAST nämna erfarenhet som står i CV:t eller projektlistan. Inte
erfarenhet som vore lämplig. Inte erfarenhet som annonsen efterfrågar.
Inte erfarenhet som låter rimlig för någon med den här bakgrunden.

Det här går fel på ett bestämt sätt: annonsen söker någon med
café-erfarenhet, CV:t saknar den, och brevet skriver ändå "jag har
arbetat i café med kassa och högt tempo". Brevet skickas till en riktig
arbetsgivare i kandidatens namn. Det är inte ett fel i formuleringen —
det är en påhittad anställning.

SAKNAS ERFARENHETEN: skriv det rakt. Säg vad kandidaten faktiskt har som
ligger närmast, och att hen lär sig snabbt. "Jag har ingen tidigare
café-erfarenhet, men har arbetat med kundkontakt inom vård och är van
vid högt tempo" är ett bättre brev än ett påhittat, och det enda som är
sant.

Överdriv inte heller: ett kursprojekt är ett kursprojekt, inte "erfarenhet
av att bygga produktionssystem". En roll på tre månader är inte "flera
års erfarenhet".

Övriga regler:
- Kort: 150–250 ord. Inga floskler ("passionerad", "driven", "brinner för",
  "övertygad om att mina färdigheter", "bidra till att stärka ert team").
- Konkret: nämn projekt och erfarenheter, inte adjektiv.
- Utgå från kandidatens ton-instruktioner om sådana finns.
- Svara på det annonsen faktiskt efterfrågar — använd de citerade kraven,
  men bara med det kandidaten faktiskt har.
- Hälsningsfras i början och avslutning med namn är OBLIGATORISKA.
- Skriv ALDRIG mejladress, telefonnummer eller länkar. Appen lägger till
  kontaktuppgifterna automatiskt efter namnet, hämtade från profilen —
  de i CV:t kan vara gamla, och brevet skickas från profilens adress.

Svara ENDAST med JSON, inga kodstaket:
{"subject": "Ansökan: <tjänstetitel>",
 "body": "brevet med \\n\\n mellan stycken",
 "belagg": [{"pastaende": "det brevet påstår om kandidaten",
             "cv_rad": "raden ur CV:t eller projektet som styrker det, ordagrant"}],
 "change_note": "en mening om vad du gjorde"}

belagg är inte dokumentation, det är arbetsmomentet. Innan du skriver
klart: gå igenom varje mening som påstår något om kandidatens bakgrund
och leta upp raden i CV:t som styrker den. Hittar du ingen rad — stryk
meningen ur brevet. cv_rad måste vara kopierad ordagrant ur CV:t eller
projektlistan ovan, på deras eget språk (CV:t kan vara på engelska även
när brevet är på svenska). Håll varje cv_rad kort — en rad räcker, inte
hela stycket.`;

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

// ------------------------------------------------------------
// Structural guarantee. Smaller models drop the greeting or the
// sign-off maybe 1 letter in 3, and this app SENDS these — a
// letter ending mid-thought would go to a real employer. The
// prompt asks; this enforces.
// ------------------------------------------------------------
const GREETING_RE = /^\s*(hej|hejsan|god dag|till|bäste|bästa)\b/i;
const CLOSING_RE = /(vänliga hälsningar|med vänlig hälsning|hälsningar|mvh|bästa hälsningar)\s*,?/i;

// A line in the sign-off that is contact details rather than a name:
// an email address, a phone number (7+ digits once separators are
// ignored), or a profile link. Only ever applied AFTER the closing
// phrase, so a phone number quoted in the body itself is left alone.
const CONTACT_LINE_RE = /(\S+@\S+\.\S+)|(?:[\d][\d\s\-+()]{6,}\d)|\b(linkedin|github|portfolio)\b/i;

// `who` is the profile ({ name, email, phone }); a bare string still
// works, because callers that only have a name predate the rest.
export function ensureLetterShape(body, who) {
  const p = typeof who === 'string' ? { name: who } : (who || {});
  const name = p.name;
  let text = String(body || '').trim().replace(/\n{3,}/g, '\n\n');

  if (!GREETING_RE.test(text)) text = `Hej,\n\n${text}`;

  if (!CLOSING_RE.test(text)) {
    text = `${text}\n\nVänliga hälsningar,\n${name || ''}`.trimEnd();
  } else if (name && !text.toLowerCase().includes(String(name).toLowerCase())) {
    // closing present but the name was dropped after it
    text = `${text}\n${name}`;
  }

  // ----------------------------------------------------------
  // How the employer answers.
  //
  // Every letter ended at the name. A campaign letter is a cold mail to
  // a stranger who has no other record of the sender, and a reply-to
  // header is not something a recruiter reads off a printout or
  // forwards to a colleague — so the phone number simply was not there
  // when someone wanted to call.
  //
  // Appended here rather than asked of the model for the same reason
  // the greeting and closing are: contact details are facts, and a
  // model that paraphrases a phone number produces a letter that looks
  // right and cannot be answered. Idempotent on the email address, so
  // regenerating, editing or re-shaping a letter never stacks it up.
  // ----------------------------------------------------------
  const contact = [p.email, p.phone].map((v) => String(v || '').trim()).filter(Boolean);
  if (contact.length) {
    // Models write a contact line of their own, lifted off the CV. That
    // produced two blocks with DIFFERENT addresses — an old proton.me
    // beside the profile's gmail — on a mail actually sent from the
    // gmail account. So any contact-looking line in the sign-off is
    // dropped and replaced: the profile is the one place these are
    // maintained, and a stale address in a cold email is a reply that
    // never arrives.
    const at = text.search(CLOSING_RE);
    if (at !== -1) {
      const head = text.slice(0, at);
      const tail = text.slice(at).split('\n')
        .filter((line) => !CONTACT_LINE_RE.test(line));
      text = (head + tail.join('\n')).trimEnd();
    }
    text = `${text}\n${contact.join(' · ')}`;
  }
  return text;
}

async function loadContext(adId, { searchId = null } = {}) {
  // named columns: SELECT * drags the CV bytea (68 kB) through every
  // letter generation for no reason
  const { rows: [profile] } = await pool.query(
    `SELECT id, name, email, phone, city, cv_text, about_text, tone_text
     FROM profile LIMIT 1`);
  if (!profile) throw new Error('no profile — run db:seed');

  // An application's own CV wins: if the user swapped the document for
  // this one letter, the letter has to be written from that document or
  // it will argue from a CV the employer never receives.
  const { rows: [own] } = await pool.query(
    `SELECT cv_text FROM applications WHERE ad_id = $1 AND profile_id = $2`,
    [adId, profile.id]
  );
  if (own?.cv_text?.trim()) {
    profile.cv_text = own.cv_text;
  } else if (searchId) {
    // otherwise letters answer with whatever CV that search is using
    const { rows: [s] } = await pool.query(
      `SELECT cv_text FROM searches WHERE id = $1`, [searchId]
    );
    if (s?.cv_text?.trim()) profile.cv_text = s.cv_text;
  }
  if (!profile.cv_text?.trim()) {
    throw new Error('Inget CV inlagt — ladda upp ett CV innan brev kan skrivas.');
  }

  const { rows: [ad] } = await pool.query(`SELECT * FROM ads WHERE id = $1`, [adId]);
  if (!ad) throw new Error(`no ad ${adId}`);

  const { rows: projects } = await pool.query(
    `SELECT * FROM projects WHERE profile_id = $1 AND is_active`, [profile.id]
  );

  // Best match_result for this ad, any search — for quotes + lead
  // project. score IS NOT NULL is load-bearing: a queued-but-unjudged
  // row has no quotes, and Postgres sorts NULLs FIRST under DESC, so
  // without it the pending row would outrank every real score and the
  // letter would be written off nothing.
  const { rows: [match] } = await pool.query(
    `SELECT m.*, p.name AS lead_project_name
     FROM match_results m LEFT JOIN projects p ON p.id = m.lead_project_id
     WHERE m.ad_id = $1 AND m.score IS NOT NULL
     ORDER BY m.score DESC LIMIT 1`, [adId]
  );

  return { profile, projects, ad, match };
}

// ------------------------------------------------------------
// draftLetter: create (or return existing) application + v1.
// UNIQUE(ad_id) guarantees one application per ad, ever.
// ------------------------------------------------------------
export async function draftLetter(adId, { originSearchId = null } = {}) {
  const ctx = await loadContext(adId, { searchId: originSearchId });

  const existing = await pool.query(
    `SELECT * FROM applications WHERE ad_id = $1 AND profile_id = $2`,
    [adId, ctx.profile.id]
  );
  if (existing.rows[0]?.letter_text) return existing.rows[0];

  const draft = await llmJson({
    tier: 'write',
    // The evidence array is part of the response now, and on a letter
    // with several claims it pushed past 2000 — the model stopped
    // mid-JSON and every retry did the same, so the letter failed
    // rather than arriving unverified. Headroom is cheaper than that.
    maxTokens: 3500,
    system: LETTER_SYSTEM,
    messages: [{ role: 'user', content: letterContext(ctx) }],
  });
  draft.body = ensureLetterShape(draft.body, ctx.profile);

  const { rows: [app] } = await pool.query(
    `INSERT INTO applications (ad_id, profile_id, origin_search_id, status, subject, letter_text, letter_version)
     VALUES ($1, $2, $3, 'drafted', $4, $5, 1)
     ON CONFLICT (profile_id, ad_id) DO UPDATE SET
       subject = EXCLUDED.subject, letter_text = EXCLUDED.letter_text,
       letter_version = 1, updated_at = now()
     RETURNING *`,
    [adId, ctx.profile.id, originSearchId, draft.subject, draft.body]
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

  const ctx = await loadContext(app.ad_id, { searchId: app.origin_search_id });

  const draft = await llmJson({
    tier: 'write',
    maxTokens: 2000,
    system: LETTER_SYSTEM,
    messages: [
      { role: 'user', content: letterContext(ctx) },
      { role: 'assistant', content: JSON.stringify({ subject: app.subject, body: app.letter_text }) },
      { role: 'user', content: `Revidera brevet enligt: ${instruction}\nSvara med samma JSON-format, inklusive "change_note".` },
    ],
  });
  draft.body = ensureLetterShape(draft.body, ctx.profile);
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
