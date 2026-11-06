// Proves a failed send is sorted by what it means, and that a campaign
// acts on the code: retry, pause, and release an ad only when Gmail
// cannot have taken the letter.
//
//   node scripts/prove-campaign-errors.js
//
// On 5 Nov a campaign paused on "Connection timeout" and then on
// "Unexpected socket close": neither was on the list of failures that
// fix themselves. Each pause also left the failed letter's draft behind,
// which counts as an application, so that ad was never tried again.
//
//   1. real nodemailer errors, made against a fake SMTP server on this
//      machine, get the right code (src/felkoder.js) — so an upgrade
//      that rewords a message fails here, not in a campaign
//   2. a connection dropped AFTER the letter was handed over is never
//      "before the letter": that one may have arrived
//   3. a failure that fixes itself is retried, and pauses the campaign
//      only at FEL_I_RAD in a row; a letter sent in between resets it
//   4. a rejected login pauses at once, with its code in the reason
//   5. a draft is released only after a before-the-letter failure — by
//      code, or by message for rows from before codes — never after an
//      unknown outcome, and never a draft written by hand
//   6. PÅ no longer starts a run on Vercel: the route has one
//      runAutoApply, the manual run's
//
// Nothing is sent: the fake server listens on 127.0.0.1 and the rows
// are throwaway ones, removed again.
import 'dotenv/config';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { pool } from '../src/db.js';
import { mejlfel } from '../src/felkoder.js';
import { efterSändfel, släppFastaUtkast, tillfälligaFelIRad, FEL_I_RAD } from '../src/autoapply.js';

let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};

// ---- a fake SMTP server; `svar` decides how it answers each command ----
async function server(svar) {
  const s = net.createServer((sock) => {
    let buf = '';
    let iData = false;
    const greet = svar.greeting === undefined ? '220 fake ESMTP' : svar.greeting;
    if (greet === 'close') { sock.destroy(); return; }
    if (greet) sock.write(`${greet}\r\n`);
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const rad = buf.slice(0, i); buf = buf.slice(i + 2);
        if (iData) {
          if (rad !== '.') continue;
          iData = false;
          if (svar.efterData === 'close') { sock.destroy(); return; }
          sock.write(`${svar.efterData || '250 ok'}\r\n`);
          continue;
        }
        const kmd = rad.split(' ')[0].toUpperCase();
        if (kmd === 'EHLO') sock.write(svar.auth ? '250-fake\r\n250 AUTH PLAIN\r\n' : '250 fake\r\n');
        else if (kmd === 'AUTH') sock.write(`${svar.auth}\r\n`);
        else if (kmd === 'MAIL') sock.write(`${svar.mail || '250 ok'}\r\n`);
        else if (kmd === 'RCPT') { if (svar.rcpt !== 'tyst') sock.write(`${svar.rcpt || '250 ok'}\r\n`); }
        else if (kmd === 'DATA') { sock.write('354 go\r\n'); iData = true; }
        else if (kmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  return s;
}

async function skicka(port, { auth = false, greetingTimeout = 2000, socketTimeout = 2000 } = {}) {
  const t = nodemailer.createTransport({
    host: '127.0.0.1', port, secure: false, ignoreTLS: true,
    connectionTimeout: 2000, greetingTimeout, socketTimeout,
    ...(auth ? { auth: { user: 'bevis@example.invalid', pass: 'fel' } } : {}),
  });
  try {
    await t.sendMail({ from: 'bevis@example.invalid', to: 'mottagare@example.invalid', subject: 'x', text: 'x' });
    return null;
  } catch (err) { return err; }
}

async function fall(namn, svar, väntat, väntatFöre, opts) {
  const s = await server(svar);
  const err = await skicka(s.address().port, opts);
  s.close();
  const f = mejlfel(err);
  kolla(`1. ${namn}`, f.kod === väntat && f.föreBrev === väntatFöre,
    `${f.kod}${f.föreBrev ? ', före brevet' : ''} — ${String(err?.message).slice(0, 50)}`);
  return f;
}

// ---- 1 + 2 ----
{
  const ledig = net.createServer(); await new Promise((ok) => ledig.listen(0, '127.0.0.1', ok));
  const port = ledig.address().port; ledig.close();
  const err = await skicka(port);
  const f = mejlfel(err);
  kolla('1. stängd port', f.kod === 'MAIL_CONNECT_FAILED' && f.föreBrev, `${f.kod} — ${err?.message}`);
}
await fall('servern stänger före hälsningen', { greeting: 'close' }, 'MAIL_CONNECT_FAILED', true);
await fall('servern hälsar aldrig', { greeting: '' }, 'MAIL_CONNECT_FAILED', true, { greetingTimeout: 300 });
await fall('fel inloggning (535)', { auth: '535 5.7.8 Username and Password not accepted' },
  'MAIL_LOGIN_REJECTED', true, { auth: true });
await fall('Gmails dagsgräns (550 5.4.5)', { mail: '550 5.4.5 Daily user sending limit exceeded' },
  'MAIL_SEND_LIMIT', true);
await fall('okänd mottagare (550 5.1.1)', { rcpt: '550 5.1.1 The email account does not exist' },
  'MAIL_RECIPIENT_REJECTED', true);
await fall('"försök igen senare" efter brevet (421)', { efterData: '421 4.7.0 Try again later' },
  'MAIL_RATE_LIMITED', true);
await fall('brevet avvisat (554)', { efterData: '554 5.7.1 Message rejected' }, 'MAIL_REJECTED', true);
const efter = await fall('2. anslutningen dör efter brevet', { efterData: 'close' }, 'MAIL_CONNECTION_LOST', false);
await fall('2. servern tystnar mitt i samtalet', { rcpt: 'tyst' }, 'MAIL_CONNECTION_LOST', false,
  { socketTimeout: 300 });
// The exact shape nodemailer gives a connection that never opens
// (smtp-connection: 'Connection timeout', ETIMEDOUT) — not producible
// against localhost, which always answers.
const tidsgräns = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' });
kolla('1. "Connection timeout" (5 nov)', mejlfel(tidsgräns).kod === 'MAIL_CONNECT_FAILED' && mejlfel(tidsgräns).föreBrev);
const pool15 = Object.assign(new Error('(EMAXCONNSESSION) max clients reached in session mode'), {});
kolla('1. databasen full', mejlfel(pool15).kod === 'DB_UNAVAILABLE' && !mejlfel(pool15).föreBrev);
kolla('2. ingen regel kallar ett avbrott efter brevet för "före"', !efter.föreBrev);

// ---- 3 – 5, on throwaway rows ----
const KÖRNING = `${Date.now()}`;
const ids = { ads: [], profile: null, search: null };
try {
  const { rows: [p] } = await pool.query(
    `INSERT INTO profile (name, email) VALUES ('Bevis kampanjfel', $1) RETURNING id`,
    [`proof+kampanj-${KÖRNING}@example.invalid`]);
  ids.profile = p.id;
  const { rows: [s] } = await pool.query(
    `INSERT INTO searches (profile_id, name, criteria_text, auto_apply_enabled, campaign_created_at)
     VALUES ($1, 'Bevis', 'bevis', true, now()) RETURNING id`, [p.id]);
  ids.search = s.id;
  const annons = async (n) => {
    const { rows: [a] } = await pool.query(
      `INSERT INTO ads (source, external_id, fingerprint, title, employer, description, apply_email)
       VALUES ('manual', $1, $1, 'Bevis', 'Bevisbolaget', 'x', 'jobb@example.invalid') RETURNING id`,
      [`prove-kampanj-${KÖRNING}-${n}`]);
    ids.ads.push(a.id);
    return a.id;
  };
  const utkast = async (adId, av = 'auto') => pool.query(
    `INSERT INTO applications (ad_id, profile_id, origin_search_id, status, subject, letter_text, sent_by)
     VALUES ($1, $2, $3, 'drafted', 'x', 'x', $4)`, [adId, p.id, s.id, av]);
  const logga = (adId, outcome, code, detail) => pool.query(
    `INSERT INTO auto_apply_log (search_id, ad_id, outcome, code, detail) VALUES ($1,$2,$3,$4,$5)`,
    [s.id, adId, outcome, code, detail]);
  const pausad = async () => (await pool.query(
    `SELECT auto_apply_enabled AS på, auto_apply_paused_reason AS orsak FROM searches WHERE id = $1`, [s.id])).rows[0];
  const c = { ad_id: await annons('c'), score: 80, title: 'Bevis', apply_email: 'jobb@example.invalid' };

  // ---- 3 ----
  const stopp = [];
  for (let i = 1; i <= FEL_I_RAD; i += 1) {
    const results = { skipped: [] };
    stopp.push(await efterSändfel(tidsgräns, { searchId: s.id, search: { profile_id: p.id }, c, results }));
    const nu = await pausad();
    if (i < FEL_I_RAD) {
      if (!nu.på || results.paused) { kolla(`3. försök ${i} pausar inte`, false, nu.orsak); break; }
    } else {
      kolla(`3. ${FEL_I_RAD - 1} tillfälliga fel i rad: kampanjen fortsätter`, stopp.slice(0, -1).every((x) => x === 'stopp'));
      kolla(`3. det ${FEL_I_RAD}:e pausar, med kod i orsaken`,
        !nu.på && results.paused && /MAIL_CONNECT_FAILED/.test(nu.orsak || ''), nu.orsak);
    }
  }
  await logga(null, 'sent', null, 'ett brev gick iväg');
  kolla('3. ett skickat brev nollställer räkningen', (await tillfälligaFelIRad(s.id)) === 0);

  // ---- 4 ----
  await pool.query(`UPDATE searches SET auto_apply_enabled = true, auto_apply_paused_reason = NULL WHERE id = $1`, [s.id]);
  const inlogg = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'),
    { code: 'EAUTH', responseCode: 535 });
  const r4 = { skipped: [] };
  await efterSändfel(inlogg, { searchId: s.id, search: { profile_id: p.id }, c, results: r4 });
  const efterInlogg = await pausad();
  kolla('4. fel inloggning pausar direkt, med koden', !efterInlogg.på && /MAIL_LOGIN_REJECTED/.test(efterInlogg.orsak || ''),
    efterInlogg.orsak);

  // ---- 5 ----
  const släpps = await annons('släpps');      await utkast(släpps);      await logga(släpps, 'skipped', 'MAIL_CONNECT_FAILED', 'x');
  const kanske = await annons('kanske');      await utkast(kanske);      await logga(kanske, 'skipped', 'MAIL_CONNECTION_LOST', 'x');
  const gammal = await annons('gammal');      await utkast(gammal);      await logga(gammal, 'failed', null, 'Connection timeout');
  const gammalOsäker = await annons('gosäker'); await utkast(gammalOsäker); await logga(gammalOsäker, 'skipped', null, 'nätverksfel, försöker igen: read ECONNRESET');
  const båda = await annons('båda');          await utkast(båda);        await logga(båda, 'skipped', 'MAIL_CONNECT_FAILED', 'x'); await logga(båda, 'skipped', 'MAIL_CONNECTION_LOST', 'x');
  const handskrivet = await annons('hand');   await utkast(handskrivet, 'user'); await logga(handskrivet, 'skipped', 'MAIL_CONNECT_FAILED', 'x');
  const utanFel = await annons('utan');       await utkast(utanFel);

  const antal = await släppFastaUtkast(s.id);
  const kvar = new Set((await pool.query(
    `SELECT ad_id FROM applications WHERE origin_search_id = $1`, [s.id])).rows.map((r) => r.ad_id));
  kolla('5. släpps efter ett fel före brevet (kod)', !kvar.has(släpps));
  kolla('5. släpps efter ett fel före brevet (gammal rad, text)', !kvar.has(gammal));
  kolla('5. ligger kvar efter ett okänt utfall (kod)', kvar.has(kanske));
  kolla('5. ligger kvar efter ett okänt utfall (gammal rad, text)', kvar.has(gammalOsäker));
  kolla('5. ligger kvar när ett av flera försök kan ha gått fram', kvar.has(båda));
  kolla('5. ett handskrivet utkast rörs aldrig', kvar.has(handskrivet));
  kolla('5. ett utkast utan felrad rörs inte', kvar.has(utanFel));
  kolla('5. släppet står i kampanjloggen', antal === 2 && Number((await pool.query(
    `SELECT count(*) FROM auto_apply_log WHERE search_id = $1 AND detail LIKE 'utkast släppt%'`, [s.id])).rows[0].count) === 2,
    `${antal} släppta`);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  if (ids.search) {
    await pool.query(`DELETE FROM auto_apply_log WHERE search_id = $1`, [ids.search]).catch(() => {});
    await pool.query(`DELETE FROM applications WHERE origin_search_id = $1`, [ids.search]).catch(() => {});
    await pool.query(`DELETE FROM searches WHERE id = $1`, [ids.search]).catch(() => {});
  }
  if (ids.ads.length) await pool.query(`DELETE FROM ads WHERE id = ANY($1)`, [ids.ads]).catch(() => {});
  if (ids.profile) await pool.query(`DELETE FROM profile WHERE id = $1`, [ids.profile]).catch(() => {});
  await pool.end();
}

// ---- 6 ----
const route = readFileSync('app/api/autoapply/route.js', 'utf8');
const körningar = (route.match(/runAutoApply\(/g) || []).length;
kolla('6. PÅ startar ingen körning på Vercel — bara Kör nu gör det', körningar === 1, `${körningar} anrop`);

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
