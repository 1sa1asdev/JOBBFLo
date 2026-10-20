// Proves that one user cannot reach another user's rows — through a real
// server, with two real logged-in users, not by reading the code.
//
//   PROVE_BASE_URL=http://localhost:3100 node scripts/prove-owner-checks.js
//
// The server must run with AUTH_SECRET set (login on) and against the
// same DATABASE_URL as this script. CI starts exactly that.
//
// What it does:
//   1. signs up two users, A and B, each with their own session
//   2. gives B a search, a campaign, an application with a letter, a mail
//      thread, a suggested reply, an attachment and a checklist
//   3. as A: every route that takes an id is called with B's ids — each
//      must answer 404, and B's rows must be exactly as they were
//   4. as A: every list and summary — none of B's rows may appear
//   5. as B: the same reads work, so the checks did not just close
//      everything
//
// Every row it makes is removed again, whatever happens.
import 'dotenv/config';
import { pool } from '../src/db.js';

const BAS = process.env.PROVE_BASE_URL || 'http://localhost:3100';
const KÖRNING = `${Date.now()}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(62)}${info ? ` ${info}` : ''}`);
};

async function anrop(cookie, metod, väg, body) {
  const res = await fetch(`${BAS}${väg}`, {
    method: metod,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}

async function skapaAnvändare(namn) {
  const email = `proof+${namn}-${KÖRNING}@example.invalid`;
  const res = await fetch(`${BAS}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Bevis ${namn}`, email, password: `losenord-${KÖRNING}` }),
  });
  if (res.status !== 201) throw new Error(`signup ${namn}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const { rows: [p] } = await pool.query(
    `SELECT p.id FROM profile p JOIN users u ON u.id = p.user_id WHERE u.email = $1`, [email]);
  return { email, cookie, profileId: p.id };
}

const städa = async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE 'proof+%-${KÖRNING}@example.invalid'`);
  await pool.query(`DELETE FROM ads WHERE external_id LIKE 'prove-owner-${KÖRNING}%'`);
  // a manual ad made through the API has no external_id to find it by
  await pool.query(`DELETE FROM ads WHERE title LIKE '%bevisord${KÖRNING}%'`);
};

try {
  // ---- the server must have login on, or none of this means anything ----
  const utan = await anrop(null, 'GET', '/api/profile');
  if (utan.status !== 401) {
    throw new Error(`servern på ${BAS} svarade ${utan.status} utan inloggning — starta den med AUTH_SECRET`);
  }
  kolla('servern kräver inloggning', true, '401 utan session');

  const A = await skapaAnvändare('a');
  const B = await skapaAnvändare('b');
  kolla('två användare med egna sessioner', Boolean(A.cookie && B.cookie && A.profileId !== B.profileId));

  // ---- B's rows ----
  const { rows: [ad] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description, apply_email)
     VALUES ('manual', $1, $1, 'Bevistjänst', 'Bevisbolaget AB', 'Testannons för ägarkontroller.', 'jobb@example.invalid')
     RETURNING id`, [`prove-owner-${KÖRNING}`]);
  const { rows: [sök] } = await pool.query(
    `INSERT INTO searches (profile_id, name, criteria_text, campaign_created_at, cv_text)
     VALUES ($1, 'B:s sökning', 'B:s kriterier', now(), 'B:s CV') RETURNING id`, [B.profileId]);
  await pool.query(`INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'user', 'B:s chatt')`, [sök.id]);
  await pool.query(
    `INSERT INTO match_results (search_id, ad_id, check_cv_key) VALUES ($1, $2, 'bevis-nyckel')`, [sök.id, ad.id]);
  await pool.query(
    `INSERT INTO ad_checks (ad_id, cv_key, items, score, summary)
     VALUES ($1, 'bevis-nyckel', '[{"name":"krav","cv_belagg":"B:s hemliga CV-rad"}]'::jsonb, 42, 'B:s checklista')`,
    [ad.id]);
  const { rows: [ans] } = await pool.query(
    `INSERT INTO applications (ad_id, profile_id, origin_search_id, status, subject, letter_text, sent_to, sent_at)
     VALUES ($1, $2, $3, 'drafted', 'B:s ämne', 'B:s brev', NULL, NULL) RETURNING id`,
    [ad.id, B.profileId, sök.id]);
  const { rows: [mejl] } = await pool.query(
    `INSERT INTO email_messages (application_id, direction, from_addr, to_addr, subject, body_text, sent_at)
     VALUES ($1, 'inbound', 'hr@example.invalid', 'b@example.invalid', 'Svar', 'B:s mejl', now()) RETURNING id`,
    [ans.id]);
  const { rows: [förslag] } = await pool.query(
    `INSERT INTO suggested_replies (application_id, reply_to_id, body) VALUES ($1, $2, 'B:s utkast') RETURNING id`,
    [ans.id, mejl.id]);
  const { rows: [bilaga] } = await pool.query(
    `INSERT INTO attachments (profile_id, search_id, filename, mime, bytes, size_bytes)
     VALUES ($1, $2, 'b.pdf', 'application/pdf', '\\x00'::bytea, 1) RETURNING id`, [B.profileId, sök.id]);

  const ögonblick = async () => {
    const { rows: [r] } = await pool.query(
      `SELECT s.name, s.deleted_at IS NULL AS finns, s.auto_apply_enabled, s.criteria_text,
              m.shortlisted_at IS NULL AS ej_favorit, m.score_requested_at IS NULL AS ej_begärd,
              a.status, a.letter_text, a.followup_enabled,
              (SELECT count(*) FROM email_messages WHERE application_id = a.id)::int AS mejl,
              (SELECT dismissed FROM suggested_replies WHERE id = $4) AS avfärdad,
              (SELECT count(*) FROM attachments WHERE id = $5)::int AS bilagor,
              (SELECT count(*) FROM search_messages WHERE search_id = s.id)::int AS chatt
       FROM searches s JOIN match_results m ON m.search_id = s.id
       JOIN applications a ON a.id = $3
       WHERE s.id = $1 AND m.ad_id = $2`, [sök.id, ad.id, ans.id, förslag.id, bilaga.id]);
    return JSON.stringify(r);
  };
  const före = await ögonblick();

  // ---- 3. as A, with B's ids: everything 404, nothing changes ----
  const S = sök.id; const AP = ans.id;
  const förbjudna = [
    ['GET', `/api/searches/${S}`],
    ['PATCH', `/api/searches/${S}`, { name: 'kapad' }],
    ['DELETE', `/api/searches/${S}`],
    ['GET', `/api/searches/${S}/filters`],
    ['PATCH', `/api/searches/${S}/filters`, { add: { key: 'q', value: 'kapad' } }],
    ['POST', `/api/searches/${S}/messages`, { message: 'kapad' }],
    ['GET', `/api/searches/${S}/results`],
    ['POST', `/api/searches/${S}/scan`],
    ['POST', `/api/searches/${S}/score`, { ad_ids: [ad.id] }],
    ['PATCH', `/api/searches/${S}/shortlist`, { ad_id: ad.id }],
    ['GET', `/api/applications/${AP}`],
    ['PATCH', `/api/applications/${AP}`, { letter_text: 'kapad', followup_enabled: true }],
    ['GET', `/api/applications/${AP}/attachments`],
    ['POST', `/api/applications/${AP}/external`, {}],
    ['POST', `/api/applications/${AP}/revise`, { instruction: 'kapad' }],
    ['POST', `/api/applications/${AP}/send`, {}],
    ['GET', `/api/inbox/${AP}`],
    ['POST', `/api/inbox/${AP}/reply`, { body: 'kapad' }],
    ['PATCH', `/api/suggestions/${förslag.id}`, {}],
    ['GET', `/api/autoapply/letter?search=${S}`],
    ['POST', '/api/autoapply/letter', { searchId: S }],
    ['PATCH', '/api/autoapply/letter', { searchId: S, approved: true }],
    ['GET', `/api/autoapply/leads?search=${S}`],
    ['POST', '/api/autoapply/lead', { searchId: S, employer: 'Kapad AB', email: 'kapad@example.invalid' }],
    ['POST', '/api/autoapply/lead/bulk', { searchId: S, contacts: [{ email: 'kapad@example.invalid', employer: 'Kapad AB' }] }],
    ['PATCH', '/api/autoapply', { searchId: S, enabled: true, criteria: 'kapad' }],
    ['POST', '/api/autoapply', { searchId: S, dryRun: true }],
    ['GET', `/api/autoapply/attachments?search=${S}`],
    ['DELETE', `/api/autoapply/attachments?id=${bilaga.id}`],
    ['GET', `/api/cv?search=${S}`],
    ['DELETE', `/api/cv?search=${S}`],
    ['POST', '/api/profile/cv-profile', { searchId: S }],
    // a draft "from" B's search would be written from B's tailored CV
    ['POST', '/api/applications', { adId: ad.id, searchId: S }],
  ];
  const släppte = [];
  for (const [metod, väg, body] of förbjudna) {
    const r = await anrop(A.cookie, metod, väg, body);
    if (r.status !== 404) släppte.push(`${metod} ${väg} → ${r.status}`);
  }
  kolla(`A får 404 på alla ${förbjudna.length} anrop mot B:s rader`, !släppte.length, släppte.join(' | '));
  kolla('B:s rader är oförändrade efteråt', (await ögonblick()) === före);

  // The ad is shared, but whose it is underneath is not.
  const annons = await anrop(A.cookie, 'GET', `/api/ads/${ad.id}?search=${S}`);
  kolla('annonsen visas, men inte B:s matchning, ansökan eller checklista',
    annons.status === 200 && !annons.data.match && !annons.data.application && !annons.data.check);
  const annonsUtanSök = await anrop(A.cookie, 'GET', `/api/ads/${ad.id}`);
  kolla('… inte heller via reserven utan sökning',
    !annonsUtanSök.data?.check && !JSON.stringify(annonsUtanSök.data || {}).includes('hemliga'));

  // ---- 4. A's lists and sums contain nothing of B's ----
  const listor = [
    ['/api/searches', (d) => !JSON.stringify(d).includes(S)],
    ['/api/inbox?source=user', (d) => !JSON.stringify(d).includes(AP)],
    ['/api/inbox?source=auto', (d) => !JSON.stringify(d).includes(AP)],
    ['/api/autoapply', (d) => !JSON.stringify(d).includes(S)],
    ['/api/dashboard', (d) => Number(d.total?.utkast || 0) === 0 && !JSON.stringify(d).includes('B:s')],
  ];
  for (const [väg, ren] of listor) {
    const r = await anrop(A.cookie, 'GET', väg);
    kolla(`${väg} visar inget av B:s`, r.status === 200 && ren(r.data), `HTTP ${r.status}`);
  }
  const pulsA = await anrop(A.cookie, 'GET', '/api/pulse');
  const pulsB = await anrop(B.cookie, 'GET', '/api/pulse');
  kolla('pulsen räknar bara egna rader', pulsA.data?.version !== pulsB.data?.version,
    `A ${pulsA.data?.version} · B ${pulsB.data?.version}`);
  const pulsAmedSök = await anrop(A.cookie, 'GET', `/api/pulse?search=${S}`);
  kolla('pulsen ger inget om B:s sökning', pulsAmedSök.data?.search === null);

  // ---- 5. B still reaches everything ----
  const egna = [
    ['GET', `/api/searches/${S}`], ['GET', `/api/applications/${AP}`], ['GET', `/api/inbox/${AP}`],
    ['GET', `/api/autoapply/letter?search=${S}`], ['GET', `/api/autoapply/attachments?search=${S}`],
  ];
  const nekade = [];
  for (const [metod, väg] of egna) {
    const r = await anrop(B.cookie, metod, väg);
    if (r.status !== 200) nekade.push(`${väg} → ${r.status}`);
  }
  kolla('B når sina egna rader', !nekade.length, nekade.join(' | '));
  // The inbox lists sent applications only. B's stayed a draft until now
  // on purpose: an unsent letter is the one A must not be able to send.
  await pool.query(`UPDATE applications SET status = 'sent', sent_at = now() WHERE id = $1`, [AP]);
  const inkorgB = await anrop(B.cookie, 'GET', '/api/inbox?source=user');
  kolla('B:s inkorg innehåller B:s tråd', JSON.stringify(inkorgB.data).includes(AP));
  const annonsB = await anrop(B.cookie, 'GET', `/api/ads/${ad.id}?search=${S}`);
  kolla('B ser sin egen checklista på annonsen', annonsB.data?.check?.summary === 'B:s checklista');

  // ---- 6. The shared pool: what a user does with an ad stays theirs ----
  // Every test ad carries a word no real ad has, so a search can be
  // aimed at exactly them.
  const ORD = `bevisord${KÖRNING}`;
  const poolAnnons = async (fingeravtryck) => (await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description, apply_url, published_at)
     VALUES ('platsbanken', $1, $2, $3, 'Poolbolaget AB', $4, 'https://example.invalid/jobb', now())
     RETURNING id`,
    [`prove-owner-${KÖRNING}-${Math.random().toString(36).slice(2, 8)}`, fingeravtryck,
     `Pooltjänst ${ORD}`, `Gemensam annons ${ORD}.`])).rows[0].id;
  const kampanj = async (ägare, namn) => (await pool.query(
    `INSERT INTO searches (profile_id, name, criteria_text, api_filters, campaign_created_at)
     VALUES ($1, $2, $3, $4::jsonb, now()) RETURNING id`,
    [ägare, namn, ORD, JSON.stringify({ q: ORD })])).rows[0].id;
  const hittar = async (sök, annonsId) => (await pool.query(
    `SELECT 1 FROM match_results WHERE search_id = $1 AND ad_id = $2`, [sök, annonsId])).rowCount > 0;

  const sökA = await kampanj(A.profileId, 'A:s kampanj');
  const sökB = await kampanj(B.profileId, 'B:s kampanj');

  // A adds a lead by hand, with an address A chose.
  const lead = await anrop(A.cookie, 'POST', '/api/autoapply/lead',
    { searchId: sökA, employer: 'Privatbolaget AB', email: `a-adress-${KÖRNING}@example.invalid`, title: `Privat tjänst ${ORD}` });
  kolla('A kan lägga till en egen annons', lead.status === 201, `HTTP ${lead.status}`);
  const privat = lead.data?.id;

  // A hides one pool ad and opens the link of another.
  const dold = await poolAnnons(`fp-dold-${KÖRNING}`);
  const öppnad = await poolAnnons(`fp-oppnad-${KÖRNING}`);
  await anrop(A.cookie, 'DELETE', '/api/autoapply/leads', { adId: dold, reason: 'bevis' });
  await anrop(A.cookie, 'POST', `/api/ads/${öppnad}/opened`);

  // B's campaign searches for exactly that word.
  await anrop(B.cookie, 'POST', `/api/searches/${sökB}/scan`);
  kolla('B:s sökning hittar inte A:s egna annons', !(await hittar(sökB, privat)),
    'B:s CV kunde annars skickas till A:s adress');
  kolla('A:s "visa aldrig" döljer inget för B', await hittar(sökB, dold));
  const annonsenSomB = await anrop(B.cookie, 'GET', `/api/ads/${privat}`);
  kolla('B får 404 på A:s egna annons', annonsenSomB.status === 404, `HTTP ${annonsenSomB.status}`);

  const resultatB = await anrop(B.cookie, 'GET', `/api/searches/${sökB}/results?view=alla&apply=any&limit=200`);
  const radB = (resultatB.data?.rows || resultatB.data || []).find?.((r) => r.ad_id === öppnad);
  kolla('A:s "länken öppnad" syns inte för B', radB && !radB.link_opened,
    radB ? `link_opened=${radB.link_opened}`
      : `annonsen saknas i B:s resultat (HTTP ${resultatB.status}, `
        + `${(resultatB.data?.rows || []).length} rader, i sökningen: ${await hittar(sökB, öppnad)}, `
        + `${JSON.stringify(resultatB.data?.error || resultatB.data?.counts || '').slice(0, 120)})`);

  // Two postings of one job: A applied to one; B looks at the other.
  const tvilling1 = await poolAnnons(`fp-tvilling-${KÖRNING}`);
  const tvilling2 = await poolAnnons(`fp-tvilling-${KÖRNING}`);
  await anrop(A.cookie, 'POST', `/api/ads/${tvilling1}/applied`, {});
  const dubbletter = await anrop(B.cookie, 'GET', `/api/ads/${tvilling2}`);
  const tvillingRad = (dubbletter.data?.duplicates || []).find((d) => d.id === tvilling1);
  kolla('B ser inte A:s ansökan på en dubblett', tvillingRad && !tvillingRad.status,
    tvillingRad ? `status=${tvillingRad.status}` : 'dubbletten saknas');

  // And A still sees all of it as A's own.
  await anrop(A.cookie, 'POST', `/api/searches/${sökA}/scan`);
  kolla('A:s egen sökning hittar A:s egna annons', await hittar(sökA, privat));
  kolla('… och inte den A dolt', !(await hittar(sökA, dold)));
} catch (err) {
  fel += 1;
  console.error(`✗ beviset avbröts: ${err.message}`);
} finally {
  await städa().catch((e) => console.error(`städning: ${e.message}`));
  console.log(fel ? `\n${fel} fel` : '\nallt stämmer');
  await pool.end();
  process.exitCode = fel ? 1 : 0;
}
