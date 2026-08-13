// ------------------------------------------------------------
// DEV ONLY: fills the DB with a plausible demo state (based on
// design/mockup.html's hardcoded arrays) so the UI can be built
// and reviewed without an Anthropic key, JobStream access, or a
// live mailbox. Never run in production.
//   npm run db:demo
// ------------------------------------------------------------
import { pool } from '../src/db.js';
import { fingerprint } from '../src/fetchJobs.js';

const { rows: [profile] } = await pool.query(`SELECT * FROM profile LIMIT 1`);
if (!profile) { console.error('run db:seed first'); process.exit(1); }
const { rows: projects } = await pool.query(`SELECT * FROM projects WHERE profile_id = $1`, [profile.id]);

const { rows: [search] } = await pool.query(
  `INSERT INTO searches (profile_id, name, criteria_text, api_filters, email_alias, scan_interval, last_scanned_at)
   VALUES ($1, 'Frontend / fullstack Stockholm',
     'Junior/mid frontend- eller fullstackroller i Stockholm. Inget krav på 5+ års erfarenhet, gärna React. Inte tunga .NET-legacy-grejer. Hybrid är okej.',
     '{"q":"frontend fullstack react","municipality":"Stockholm","experience-required":false}',
     'frontend', '1 hour', now() - interval '20 minutes')
   RETURNING *`, [profile.id]
);
await pool.query(
  `INSERT INTO searches (profile_id, name, criteria_text, api_filters, email_alias, scan_interval, last_scanned_at)
   VALUES ($1, 'Hotellreceptionist deltid', 'Deltidsjobb som hotellreceptionist i Stockholm.', '{}', 'hotell', '6 hours', now() - interval '1 hour')`,
  [profile.id]
);

await pool.query(
  `INSERT INTO search_messages (search_id, role, content) VALUES
   ($1, 'user', 'Junior/mid frontend- eller fullstackroller i Stockholm. Inget krav på 5+ års erfarenhet, gärna React. Inte intresserad av tunga .NET-legacy-grejer. Hybrid är okej.'),
   ($1, 'assistant', 'Filter satta via JobSearch API: IT · Stockholm · inget erfarenhetskrav · hybrid. Resten hanteras mot annonstexten.'),
   ($1, 'user', 'Bra, men jag är okej med lite .NET, bara inte COBOL-nivå legacy.'),
   ($1, 'assistant', 'Kriterium uppdaterat. Flaggar bara vid uttryckligt "legacy-system" eller "mainframe".')`,
  [search.id]
);

const ADS = [
  { title: 'Frontendutvecklare — React', employer: 'Neonpixel AB', municipality: 'Stockholm',
    email: 'jobb@neonpixel.se', deadline: 2, published: -10,
    description: `Om rollen\nNeonpixel söker en frontendutvecklare till vårt produktteam i Stockholm. Du arbetar nära design och backend i ett tvärfunktionellt team med korta beslutsvägar.\n\nVi söker dig som\n- Har erfarenhet av React och TypeScript\n- Är bekväm med modern byggkedja (Vite, ESLint)\n- Inget krav på antal års erfarenhet — vi tittar på vad du byggt\n- Kan kommunicera på svenska eller engelska\n\nVi erbjuder\nHybridarbete, tillsvidareanställning och ett team på nio personer. Tjänsten tillsätts löpande — ansök snarast.\n\nAnsökan\nSkicka CV och personligt brev till jobb@neonpixel.se.`,
    score: 96, summary: 'React-fokus, inget erfarenhetskrav, hybridarbete, Stockholm.',
    matched: [
      { quote: 'React och TypeScript', why: 'kärnan i din utbildning och dina projekt' },
      { quote: 'Inget krav på antal års erfarenhet', why: 'matchar din junior/mid-profil' },
      { quote: 'tvärfunktionellt team', why: 'din service-bakgrund är relevant' },
      { quote: 'Hybridarbete', why: 'du angav hybrid som okej' },
    ],
    flags: [{ quote: 'Tjänsten tillsätts löpande', why: 'sök snabbt', tag: 'Löpande urval' }] },
  { title: 'Fullstackutvecklare (.NET/React)', employer: 'Kärnbank Systems', municipality: 'Stockholm',
    email: 'rekrytering@karnbank.se', deadline: 11, published: -15,
    description: `Kärnbank Systems söker en fullstackutvecklare. Du arbetar i modern .NET 8 med React-frontend i Azure-miljö.\n\nVi ser gärna att du har grundläggande erfarenhet av C# och React. Kontorsnärvaro 4 dagar i veckan på vårt kontor i Stockholm.\n\nAnsök via rekrytering@karnbank.se.`,
    score: 84, summary: 'Modern .NET (ej legacy) plus React-frontend — men kontor 4 dagar/vecka.',
    matched: [
      { quote: 'modern .NET 8 med React-frontend', why: 'kombinerar din .NET-bakgrund med React' },
      { quote: 'grundläggande erfarenhet av C# och React', why: 'ingen senior-tröskel' },
    ],
    flags: [{ quote: 'Kontorsnärvaro 4 dagar i veckan', why: 'du föredrar hybrid', tag: 'Kontorskrav' }] },
  { title: 'Junior Systemutvecklare', employer: 'Polarflow AB', municipality: 'Solna',
    email: 'jobb@polarflow.se', deadline: 18, published: -8,
    description: `Polarflow söker en junior systemutvecklare. Vi arbetar med JavaScript, Node och SQL. Uttalat juniorvänlig roll med mentorskap. Hybridarbete i Solna.\n\nAnsök till jobb@polarflow.se.`,
    score: 79, summary: 'Uttalat juniorvänlig, Stockholmsregionen, hybrid.',
    matched: [
      { quote: 'JavaScript, Node och SQL', why: 'direkt i din stack' },
      { quote: 'Uttalat juniorvänlig roll med mentorskap', why: 'matchar din nivå' },
    ],
    flags: [] },
  { title: 'Backendutvecklare C#/.NET', employer: 'Fjärrvärme Digital', municipality: 'Stockholm',
    email: 'hr@fjarrvarmedigital.se', deadline: 9, published: -12,
    description: `Fjärrvärme Digital söker backendutvecklare för vidareutveckling av våra äldre kärnsystem i .NET Framework och SQL Server. Ingen frontend-del. Kontor i Stockholm.\n\nAnsök till hr@fjarrvarmedigital.se.`,
    score: 61, summary: 'Din .NET-bakgrund matchar, men äldre kärnsystem och ingen frontend-del.',
    matched: [{ quote: '.NET Framework och SQL Server', why: 'du har C#/.NET-bakgrund' }],
    flags: [
      { quote: 'äldre kärnsystem', why: 'nära din legacy-gräns', tag: 'Legacy' },
      { quote: 'Ingen frontend-del', why: 'du söker främst frontend', tag: 'Ingen frontend' },
    ] },
  { title: 'Webbutvecklare', employer: 'Butiksdata Sverige', municipality: 'Kista',
    email: 'jobb@butiksdata.se', deadline: 23, published: -22,
    description: `Butiksdata söker webbutvecklare för underhåll av våra kundsajter i PHP, jQuery och WordPress. Inget erfarenhetskrav. Kontor i Kista, deltid möjligt.\n\nAnsök till jobb@butiksdata.se.`,
    score: 57, summary: 'Stockholmsregionen och inget erfarenhetskrav, men äldre stack utan React.',
    matched: [{ quote: 'Inget erfarenhetskrav', why: 'öppen för juniora' }],
    flags: [{ quote: 'PHP, jQuery och WordPress', why: 'inte din stack, inte React', tag: 'Äldre stack' }] },
  { title: 'Systemutvecklare, mainframe COBOL', employer: 'Riksdata Legacy AB', municipality: 'Solna',
    email: 'jobb@riksdata.se', deadline: 14, published: -14,
    description: `Riksdata söker systemutvecklare till vårt mainframe-team. Arbetet sker i COBOL på stordator (legacy-system). 10+ års erfarenhet meriterande.\n\nAnsök till jobb@riksdata.se.`,
    score: 38, summary: 'Stockholmsregionen — men uttrycklig mainframe/COBOL-legacy, din undantagsregel.',
    matched: [],
    flags: [
      { quote: 'COBOL på stordator (legacy-system)', why: 'träffar din uteslutningsregel', tag: 'Mainframe/COBOL' },
      { quote: '10+ års erfarenhet meriterande', why: 'seniorprofil', tag: '10+ år' },
    ] },
];

const day = 24 * 3600 * 1000;
const adIds = {};
for (const a of ADS) {
  const fp = fingerprint({ employer: a.employer, title: a.title, municipality: a.municipality });
  const { rows: [ad] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, employer_type, municipality, region,
       description, apply_email, published_at, deadline)
     VALUES ('platsbanken', $1, $2, $3, $4, 'private', $5, 'Stockholms län', $6, $7, $8, $9)
     RETURNING id`,
    [`demo-${a.employer}`, fp, a.title, a.employer, a.municipality, a.description, a.email,
     new Date(Date.now() + a.published * day), new Date(Date.now() + a.deadline * day)]
  );
  adIds[a.employer] = ad.id;

  const lead = projects[0];
  await pool.query(
    `INSERT INTO match_results (search_id, ad_id, score, summary, matched, flags, lead_project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [search.id, ad.id, a.score, a.summary, JSON.stringify(a.matched), JSON.stringify(a.flags),
     a.score >= 75 ? lead?.id : null]
  );
}

// one drafted application (Kärnbank) + one sent-with-interview-reply thread
const draftBody = `Hej,

Jag söker rollen som fullstackutvecklare hos Kärnbank Systems. Jag läser fullstack JavaScript på Yrkeshögskolan och har bakgrund i .NET-systemutveckling — kombinationen av modern .NET och React-frontend är precis den riktning jag vill åt.

Under utbildningen har jag byggt en bokningstjänst i React och TypeScript där jag hade hand om hela gränssnittet, från komponentarkitektur till API-integration.

Innan studierna arbetade jag inom vård och café. Det har gett mig vana vid högt tempo och att förklara saker begripligt — användbart i tvärfunktionella team.

Hör gärna av er om ni vill se kod eller prata vidare.

Vänliga hälsningar,
${profile.name}`;

const { rows: [draftApp] } = await pool.query(
  `INSERT INTO applications (ad_id, origin_search_id, status, subject, letter_text, letter_version)
   VALUES ($1, $2, 'drafted', 'Ansökan: Fullstackutvecklare (.NET/React)', $3, 1) RETURNING id`,
  [adIds['Kärnbank Systems'], search.id, draftBody]
);
await pool.query(
  `INSERT INTO letter_versions (application_id, version, subject, body, change_note)
   VALUES ($1, 1, 'Ansökan: Fullstackutvecklare (.NET/React)', $2, 'Första utkastet')`,
  [draftApp.id, draftBody]
);

const sentBody = `Hej,

Jag söker rollen som junior systemutvecklare hos Polarflow. Jag läser fullstack JavaScript på Yrkeshögskolan och arbetar dagligen i just JavaScript, Node och SQL.

Vänliga hälsningar,
${profile.name}`;

const { rows: [sentApp] } = await pool.query(
  `INSERT INTO applications (ad_id, origin_search_id, status, subject, letter_text, letter_version,
     message_id, sent_to, sent_from, sent_at, followup_enabled, followup_days)
   VALUES ($1, $2, 'interview', 'Ansökan: Junior Systemutvecklare', $3, 1,
     '<demo-polarflow@jobbjakt>', 'jobb@polarflow.se', 'din+frontend@gmail.com',
     now() - interval '6 days', true, 10) RETURNING id`,
  [adIds['Polarflow AB'], search.id, sentBody]
);
await pool.query(
  `INSERT INTO letter_versions (application_id, version, subject, body, change_note)
   VALUES ($1, 1, 'Ansökan: Junior Systemutvecklare', $2, 'Första utkastet')`,
  [sentApp.id, sentBody]
);
await pool.query(
  `INSERT INTO email_messages (application_id, direction, message_id, from_addr, to_addr, subject, body_text, sent_at)
   VALUES ($1, 'outbound', '<demo-polarflow@jobbjakt>', 'din+frontend@gmail.com', 'jobb@polarflow.se',
     'Ansökan: Junior Systemutvecklare', $2, now() - interval '6 days')`,
  [sentApp.id, sentBody]
);
const { rows: [inbound] } = await pool.query(
  `INSERT INTO email_messages (application_id, direction, message_id, in_reply_to, from_addr, from_name,
     to_addr, subject, body_text, sent_at)
   VALUES ($1, 'inbound', '<demo-reply-1@polarflow.se>', '<demo-polarflow@jobbjakt>',
     'anna.lindqvist@polarflow.se', 'Anna Lindqvist', 'din+frontend@gmail.com',
     'Re: Ansökan: Junior Systemutvecklare',
     $2, now() - interval '2 hours') RETURNING id`,
  [sentApp.id, `Hej ${profile.name.split(' ')[0]},

Tack för din ansökan — vi tyckte din kombination av .NET-bakgrund och React-studier var intressant.

Vi skulle gärna vilja träffa dig för ett första samtal. Har du möjlighet någon gång nästa vecka? Tisdag eller torsdag eftermiddag fungerar bäst för oss.

Vänliga hälsningar,
Anna Lindqvist
Rekrytering, Polarflow AB`]
);
await pool.query(
  `INSERT INTO suggested_replies (application_id, reply_to_id, body, kind) VALUES ($1, $2, $3, 'reply')`,
  [sentApp.id, inbound.id, `Hej Anna,

Vad roligt att höra — tack!

Torsdag eftermiddag fungerar bra för mig, förslagsvis kl 14. Tisdag går också om det passar er bättre.

Ser fram emot att prata mer.

Vänliga hälsningar,
${profile.name.split(' ')[0]}`]
);
await pool.query(
  `INSERT INTO interview_prep (application_id, questions, claimed_note, gaps) VALUES ($1, $2, $3, $4)`,
  [sentApp.id,
   JSON.stringify([
     'Berätta om bokningstjänsten — vad byggde du själv?',
     'Hur ser du på att gå från .NET till Node i praktiken?',
     'Hur hanterar du att komma in i en befintlig kodbas?',
     'Vad vill du utvecklas inom det närmaste året?']),
   'Du skrev att du "arbetar dagligen i just JavaScript, Node och SQL". Var beredd att visa kod eller gå igenom arkitekturen i ett projekt.',
   JSON.stringify(['Annonsen nämner mentorskap — fundera på vad du vill få ut av det', 'SQL-djup: de kör Postgres i produktion'])]
);

console.log('✓ demo data inlagd (1 sökning, 6 annonser, 1 utkast, 1 intervjutråd)');
await pool.end();
