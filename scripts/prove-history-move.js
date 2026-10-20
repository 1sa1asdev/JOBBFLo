// Proves a user's history moves into their cloud account whole, and
// into nobody else's.
//
//   node scripts/prove-history-move.js
//
// Two throwaway databases on DATABASE_URL's server, both migrated: a
// "local" one with user A's history, and a "cloud" one with A's new,
// empty account, another user B, and a pool that already holds one of
// A's ads.
//
//   1. every table of A's history arrives, row for row — except the
//      candidates nobody looked at, which the cloud's scan finds again
//   2. every row has a new id, and points only at A's moved rows, A's
//      profile or the pool
//   3. ads: one the pool has is reused, one it lacks is added, a private
//      one becomes A's
//   4. the CV moves, file and all; encrypted secrets do not
//   5. campaigns arrive paused, with the reason
//   6. B is untouched, a second move is refused, and so is a move between
//      databases on different migrations
import 'dotenv/config';
import pg from 'pg';
import { migrate } from './migrate.js';
import { anslutning } from '../src/dbConfig.js';
import { flyttaHistorik } from '../src/flytt.js';

const BAS = process.env.DATABASE_URL;
const medDb = (db) => { const u = new URL(BAS); u.pathname = `/${db}`; return u.toString(); };
const KÄLLA = `jobbflo_flytt_kalla_${process.pid}`;
const MÅL = `jobbflo_flytt_mal_${process.pid}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};
const admin = async (sql) => {
  const c = new pg.Client(anslutning(medDb('postgres')));
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
};

const k = new pg.Client(anslutning(medDb(KÄLLA)));
const m = new pg.Client(anslutning(medDb(MÅL)));
try {
  for (const db of [KÄLLA, MÅL]) {
    await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${db}`);
    await migrate({ url: medDb(db), quiet: true });
  }
  await k.connect();
  await m.connect();
  const en = async (db, sql, p) => (await db.query(sql, p)).rows[0];

  // ---- the local database: A's history ----
  const A = await en(k, `INSERT INTO profile (name, email, cv_text, cv_file, cv_filename, gmail_app_password_enc, llm_provider)
    VALUES ('A Lokal', 'a@example.invalid', 'A:s CV', '\\x25504446', 'cv.pdf', 'v1.HEMLIG.HEMLIG.HEMLIG', 'openrouter') RETURNING id`);
  const ad = (db, nyckel, ägare = null) => en(db,
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description, owner_profile_id)
     VALUES ('manual', $1, $1, $1, 'Bolaget AB', 'x', $2) RETURNING id`, [nyckel, ägare]);
  const delad = await ad(k, 'delad-1');
  const stängd = await ad(k, 'stangd-2');
  const kandidat = await ad(k, 'kandidat-3');
  const privat = await ad(k, 'privat-4', A.id);
  const sök = await en(k, `INSERT INTO searches (profile_id, name, criteria_text, auto_apply_enabled, campaign_created_at)
    VALUES ($1, 'A:s kampanj', 'x', true, now()) RETURNING id`, [A.id]);
  await k.query(`INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'user', 'A:s chatt')`, [sök.id]);
  const projekt = await en(k, `INSERT INTO projects (profile_id, name, summary) VALUES ($1, 'A:s projekt', 'x') RETURNING id`, [A.id]);
  const m1 = await en(k, `INSERT INTO match_results (search_id, ad_id, score, lead_project_id) VALUES ($1, $2, 80, $3) RETURNING id`,
    [sök.id, delad.id, projekt.id]);
  await k.query(`INSERT INTO match_results (search_id, ad_id, score, score_reused_from) VALUES ($1, $2, 80, $3)`,
    [sök.id, stängd.id, m1.id]);
  await k.query(`INSERT INTO match_results (search_id, ad_id) VALUES ($1, $2)`, [sök.id, kandidat.id]);
  const ans = await en(k, `INSERT INTO applications (ad_id, profile_id, origin_search_id, status, subject, letter_text, message_id, sent_at)
    VALUES ($1, $2, $3, 'sent', 's', 'A:s brev', '<a1@example.invalid>', now()) RETURNING id`, [delad.id, A.id, sök.id]);
  await k.query(`INSERT INTO applications (ad_id, profile_id, status, subject, letter_text) VALUES ($1, $2, 'drafted', 's', 'privat brev')`,
    [privat.id, A.id]);
  const mejl = await en(k, `INSERT INTO email_messages (application_id, direction, from_addr, to_addr, subject, body_text, sent_at)
    VALUES ($1, 'inbound', 'hr@example.invalid', 'a@example.invalid', 'Svar', 'A:s mejl', now()) RETURNING id`, [ans.id]);
  await k.query(`INSERT INTO suggested_replies (application_id, reply_to_id, body) VALUES ($1, $2, 'A:s utkast')`, [ans.id, mejl.id]);
  await k.query(`INSERT INTO letter_versions (application_id, version, body) VALUES ($1, 1, 'A:s version')`, [ans.id]);
  await k.query(`INSERT INTO ad_reads (ad_id, profile_id, status, profile) VALUES ($1, $2, 'ok', '{"headline":"läst"}')`, [delad.id, A.id]);
  await k.query(`INSERT INTO ad_checks (ad_id, profile_id, cv_key, items, score) VALUES ($1, $2, 'k', '[{"name":"krav"}]', 80)`, [delad.id, A.id]);
  await k.query(`INSERT INTO never_apply (profile_id, fingerprint) VALUES ($1, 'aldrig')`, [A.id]);
  await k.query(`INSERT INTO imap_state (profile_id, mailbox, uid_validity, last_seen_uid) VALUES ($1, 'INBOX', 7, 31342)`, [A.id]);
  await k.query(`INSERT INTO llm_usage (provider, model, tier, usd, profile_id) VALUES ('x', 'x', 'bulk', 0.01, $1)`, [A.id]);
  await k.query(`INSERT INTO auto_apply_log (search_id, application_id, ad_id, outcome, detail) VALUES ($1, $2, $3, 'sent', 'A:s logg')`,
    [sök.id, ans.id, delad.id]);

  // ---- the cloud: A's empty account, B, and a pool that has 'delad-1' ----
  const uA = await en(m, `INSERT INTO users (email, auth_id) VALUES ('a@example.invalid', gen_random_uuid()) RETURNING id`);
  const nyA = await en(m, `INSERT INTO profile (user_id, name, email) VALUES ($1, 'A Google', 'a@example.invalid') RETURNING id`, [uA.id]);
  const uB = await en(m, `INSERT INTO users (email, auth_id) VALUES ('b@example.invalid', gen_random_uuid()) RETURNING id`);
  const B = await en(m, `INSERT INTO profile (user_id, name, email) VALUES ($1, 'B', 'b@example.invalid') RETURNING id`, [uB.id]);
  const molnDelad = await ad(m, 'delad-1');
  await m.query(`INSERT INTO searches (profile_id, name, criteria_text) VALUES ($1, 'B:s sökning', 'x')`, [B.id]);
  const bFöre = (await en(m, `SELECT count(*)::int AS n FROM searches WHERE profile_id = $1`, [B.id])).n;

  const räkning = await flyttaHistorik({ från: k, till: m, frånProfil: A.id, tillProfil: nyA.id });

  // ---- 1 ----
  const per = async (sql) => (await en(m, sql, [nyA.id])).n;
  const antal = {
    searches: await per(`SELECT count(*)::int AS n FROM searches WHERE profile_id = $1`),
    search_messages: await per(`SELECT count(*)::int AS n FROM search_messages sm JOIN searches s ON s.id = sm.search_id WHERE s.profile_id = $1`),
    match_results: await per(`SELECT count(*)::int AS n FROM match_results mr JOIN searches s ON s.id = mr.search_id WHERE s.profile_id = $1`),
    applications: await per(`SELECT count(*)::int AS n FROM applications WHERE profile_id = $1`),
    email_messages: await per(`SELECT count(*)::int AS n FROM email_messages e JOIN applications a ON a.id = e.application_id WHERE a.profile_id = $1`),
    suggested_replies: await per(`SELECT count(*)::int AS n FROM suggested_replies r JOIN applications a ON a.id = r.application_id WHERE a.profile_id = $1`),
    letter_versions: await per(`SELECT count(*)::int AS n FROM letter_versions v JOIN applications a ON a.id = v.application_id WHERE a.profile_id = $1`),
    ad_reads: await per(`SELECT count(*)::int AS n FROM ad_reads WHERE profile_id = $1`),
    ad_checks: await per(`SELECT count(*)::int AS n FROM ad_checks WHERE profile_id = $1`),
    never_apply: await per(`SELECT count(*)::int AS n FROM never_apply WHERE profile_id = $1`),
    imap_state: await per(`SELECT count(*)::int AS n FROM imap_state WHERE profile_id = $1 AND last_seen_uid = 31342`),
    llm_usage: await per(`SELECT count(*)::int AS n FROM llm_usage WHERE profile_id = $1`),
    projects: await per(`SELECT count(*)::int AS n FROM projects WHERE profile_id = $1`),
    auto_apply_log: await per(`SELECT count(*)::int AS n FROM auto_apply_log l JOIN searches s ON s.id = l.search_id WHERE s.profile_id = $1`),
  };
  const väntat = { searches: 1, search_messages: 1, match_results: 2, applications: 2, email_messages: 1, suggested_replies: 1,
    letter_versions: 1, ad_reads: 1, ad_checks: 1, never_apply: 1, imap_state: 1, llm_usage: 1, projects: 1, auto_apply_log: 1 };
  const avvikande = Object.keys(väntat).filter((t) => antal[t] !== väntat[t]);
  kolla('1. varje tabell kommer fram, rad för rad (utom otittade kandidater)', !avvikande.length,
    avvikande.map((t) => `${t}: ${antal[t]}/${väntat[t]}`).join(', ') || `${Object.keys(väntat).length} tabeller`);

  // ---- 2 ----
  const gamla = [sök.id, ans.id, mejl.id, m1.id, projekt.id];
  const { rows: kvarGamla } = await m.query(
    `SELECT 'searches' t FROM searches WHERE id = ANY($1) UNION ALL SELECT 'applications' FROM applications WHERE id = ANY($1)
     UNION ALL SELECT 'email_messages' FROM email_messages WHERE id = ANY($1) UNION ALL SELECT 'match_results' FROM match_results WHERE id = ANY($1)`,
    [gamla]);
  kolla('2. inga rader behåller källans id', kvarGamla.length === 0, kvarGamla.map((r) => r.t).join(', '));
  const kedja = await en(m, `SELECT
      (SELECT count(*) FROM suggested_replies r JOIN email_messages e ON e.id = r.reply_to_id
         JOIN applications a ON a.id = e.application_id WHERE a.profile_id = $1)::int AS svar,
      (SELECT count(*) FROM match_results mr JOIN match_results o ON o.id = mr.score_reused_from
         JOIN searches s ON s.id = o.search_id WHERE s.profile_id = $1)::int AS återanvänd,
      (SELECT count(*) FROM match_results mr JOIN projects p ON p.id = mr.lead_project_id WHERE p.profile_id = $1)::int AS projekt`,
  [nyA.id]);
  kolla('2. kedjorna pekar på de flyttade raderna (svar, återanvänd, projekt)',
    kedja.svar === 1 && kedja.återanvänd === 1 && kedja.projekt === 1, JSON.stringify(kedja));

  // ---- 3 ----
  const annonser = await en(m, `SELECT
      (SELECT count(*) FROM ads WHERE external_id = 'delad-1')::int AS delad,
      (SELECT count(*) FROM ads WHERE external_id = 'stangd-2')::int AS stängd,
      (SELECT count(*) FROM ads WHERE external_id = 'kandidat-3')::int AS kandidat,
      (SELECT count(*) FROM ads WHERE owner_profile_id = $1)::int AS privat,
      (SELECT count(*) FROM applications WHERE profile_id = $1 AND ad_id = $2)::int AS "påDelad"`, [nyA.id, molnDelad.id]);
  kolla('3. annonsen poolen har återanvänds, inte dubbleras', annonser.delad === 1 && annonser.påDelad === 1, JSON.stringify(annonser));
  kolla('3. en annons poolen saknar läggs till', annonser.stängd === 1);
  kolla('3. en otittad kandidat drar inte med sig sin annons', annonser.kandidat === 0);
  kolla('3. den privata annonsen blir A:s', annonser.privat === 1);

  // ---- 4 ----
  const profil = await en(m, `SELECT cv_text, length(cv_file) AS fil, gmail_app_password_enc, name, email, llm_provider
    FROM profile WHERE id = $1`, [nyA.id]);
  kolla('4. CV:t flyttar, med filen', profil.cv_text === 'A:s CV' && profil.fil === 4 && profil.llm_provider === 'openrouter');
  kolla('4. krypterade hemligheter flyttar inte', profil.gmail_app_password_enc === null);
  kolla('4. kontots adress är molnets egen', profil.email === 'a@example.invalid');

  // ---- 5 ----
  const kamp = await en(m, `SELECT auto_apply_enabled, auto_apply_paused_reason FROM searches WHERE profile_id = $1`, [nyA.id]);
  kolla('5. kampanjen kommer fram pausad, med orsak', kamp.auto_apply_enabled === false && /lokala/.test(kamp.auto_apply_paused_reason || ''));

  // ---- 6 ----
  kolla('6. B orörd', (await en(m, `SELECT count(*)::int AS n FROM searches WHERE profile_id = $1`, [B.id])).n === bFöre);
  let igen = null;
  try { await flyttaHistorik({ från: k, till: m, frånProfil: A.id, tillProfil: nyA.id }); } catch (e) { igen = e.message; }
  kolla('6. en andra flytt vägras', /redan/.test(igen || ''), igen || 'gick igenom');
  await m.query(`INSERT INTO schema_migrations (version, name, checksum, via) VALUES ('999', 'framtid', 'x', 'migration')`);
  const uC = await en(m, `INSERT INTO users (email) VALUES ('c@example.invalid') RETURNING id`);
  const C = await en(m, `INSERT INTO profile (user_id, name, email) VALUES ($1, 'C', 'c@example.invalid') RETURNING id`, [uC.id]);
  let version = null;
  try { await flyttaHistorik({ från: k, till: m, frånProfil: A.id, tillProfil: C.id }); } catch (e) { version = e.message; }
  kolla('6. olika migrationer: vägras', /migrationer/.test(version || ''), version || 'gick igenom');
  if (räkning) console.log(`  (flytten: ${JSON.stringify(räkning)})`);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  await k.end().catch(() => {});
  await m.end().catch(() => {});
  for (const db of [KÄLLA, MÅL]) await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
