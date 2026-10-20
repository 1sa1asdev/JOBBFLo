// Proves that one user's mail stays that user's — without a mail server.
//
//   node scripts/prove-imap-scope.js
//
//   1. matching   a message in A's mailbox can only ever join one of A's
//                 threads, on every rung of the resolution order — never
//                 B's, even when B wrote to the same employer
//   2. state      read positions are per user, and a user's first read
//                 starts at their own first letter
//   3. Sent       A's Sent folder is only searched for A's threads, and a
//                 stuck letter of B's is not repaired from A's mailbox
//   4. password   a mailbox Gmail keeps refusing stops and says why,
//                 while a network error keeps retrying
//   5. manager    one mailbox per user with Gmail and a letter sent,
//                 started and stopped as that changes; "Hämta post"
//                 wakes the presser's mailbox and nobody else's
//
// Two real Gmail accounts cannot run in CI, so the IMAP side is a fake
// that never touches the network. Every row it makes is removed again.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { encryptSecret } from '../src/secrets.js';
import * as imap from '../src/imap.js';

let postansvarig = null;
let harBrevlåda = null;
try { ({ postansvarig, harBrevlåda } = await import('../src/imapManager.js')); } catch { /* checked below */ }

const KÖRNING = `${Date.now()}`;
const DOMÄN = `volvo-${KÖRNING}.example`;
const BARA_B = `bara-b-${KÖRNING}.example`;
const TVÅ_A = `tva-a-${KÖRNING}.example`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};
const finns = (namn, f) => {
  const ok = typeof f === 'function';
  if (!ok) kolla(`${namn} finns`, false, 'saknas i den här koden');
  return ok;
};

const städa = async () => {
  await pool.query(
    `DELETE FROM applications WHERE profile_id IN
       (SELECT id FROM profile WHERE email LIKE 'proof+imap-%-${KÖRNING}@example.invalid')`);
  await pool.query(`DELETE FROM profile WHERE email LIKE 'proof+imap-%-${KÖRNING}@example.invalid'`);
  await pool.query(`DELETE FROM ads WHERE external_id LIKE 'prove-imap-${KÖRNING}%'`);
};

const profil = async (namn, { verifierad = true } = {}) => {
  const { rows: [p] } = await pool.query(
    `INSERT INTO profile (name, email, gmail_app_password_enc, gmail_verified_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END) RETURNING id`,
    [`Bevis ${namn}`, `proof+imap-${namn}-${KÖRNING}@example.invalid`,
     encryptSecret('bevislosenord'), verifierad]);
  return p.id;
};

let annonser = 0;
const ansökan = async (profileId, till, { status = 'sent', dagarSedan = 3, msgId = null } = {}) => {
  const nyckel = `prove-imap-${KÖRNING}-${annonser += 1}`;
  const { rows: [ad] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description)
     VALUES ('manual', $1, $1, 'Bevistjänst', 'Bevisbolaget', 'Testannons.') RETURNING id`, [nyckel]);
  const skickad = status !== 'sending';
  const { rows: [a] } = await pool.query(
    `INSERT INTO applications (ad_id, profile_id, status, subject, letter_text, sent_to, sent_from,
       message_id, sent_at, sending_since)
     VALUES ($1, $2, $3, 'Ansökan', 'Hej', $4, 'du@example.invalid', $5,
       CASE WHEN $6 THEN now() - make_interval(days => $7) END,
       CASE WHEN NOT $6 THEN now() - interval '1 hour' END)
     RETURNING id`,
    [ad.id, profileId, status, till, skickad ? msgId || `<${nyckel}@proof>` : null, skickad, dagarSedan]);
  if (skickad) {
    await pool.query(
      `INSERT INTO email_messages (application_id, direction, message_id, from_addr, to_addr, subject, body_text, sent_at)
       VALUES ($1, 'outbound', $2, 'du@example.invalid', $3, 'Ansökan', 'Hej', now() - make_interval(days => $4))`,
      [a.id, msgId || `<${nyckel}@proof>`, till, dagarSedan]);
  }
  return { id: a.id, msgId: skickad ? msgId || `<${nyckel}@proof>` : null };
};

try {
  await städa();
  const A = await profil('a');
  const B = await profil('b');
  const C = await profil('c'); // Gmail, but never sent a letter through the app

  const aVolvo = await ansökan(A, `jobb@${DOMÄN}`, { dagarSedan: 10 });
  const bVolvo = await ansökan(B, `rekrytering@${DOMÄN}`, { dagarSedan: 2 });
  const bBara = await ansökan(B, `jobb@${BARA_B}`);
  await ansökan(A, `ett@${TVÅ_A}`);
  await ansökan(A, `tva@${TVÅ_A}`);
  // An employer's answer in B's thread: its id identifies B's thread too.
  const bSvarId = `<svar-b-${KÖRNING}@proof>`;
  await pool.query(
    `INSERT INTO email_messages (application_id, direction, message_id, from_addr, to_addr, subject, body_text, sent_at)
     VALUES ($1, 'inbound', $2, $3, 'du@example.invalid', 'Re: Ansökan', 'Tack!', now())`,
    [bVolvo.id, bSvarId, `anna@${DOMÄN}`]);

  // ---------------------------------------------------------------
  // 1. Matching, rung by rung, from inside A's mailbox
  // ---------------------------------------------------------------
  const iA = (m) => imap.matchReply({ references: [], ...m, profileId: A });
  const iB = (m) => imap.matchReply({ references: [], ...m, profileId: B });

  let r = await iA({ inReplyTo: aVolvo.msgId, fromAddr: `x@${DOMÄN}` });
  kolla('1. In-Reply-To till A:s brev → A:s tråd', r.applicationId === aVolvo.id && !r.inferred);
  r = await iA({ inReplyTo: bVolvo.msgId, fromAddr: 'x@annat.example' });
  kolla('1. In-Reply-To till B:s brev, i A:s brevlåda → ingen tråd', r.applicationId === null,
    r.applicationId === bVolvo.id ? '(kopplades till B:s ansökan)' : '');
  r = await iA({ inReplyTo: bSvarId, fromAddr: 'x@annat.example' });
  kolla('1. In-Reply-To till svar i B:s tråd, hos A → ingen tråd', r.applicationId === null,
    r.applicationId === bVolvo.id ? '(kopplades till B:s ansökan)' : '');
  r = await iA({ references: ['<okand@proof>', bVolvo.msgId], fromAddr: 'x@annat.example' });
  kolla('2. sista References till B:s brev, hos A → ingen tråd', r.applicationId === null,
    r.applicationId === bVolvo.id ? '(kopplades till B:s ansökan)' : '');
  r = await iA({ fromAddr: `anna@${DOMÄN}` });
  kolla('3. domän som både A och B skrivit till, hos A → A:s tråd', r.applicationId === aVolvo.id && r.inferred,
    r.applicationId ? '' : '(ingen — B:s ansökan räknades med)');
  r = await iB({ fromAddr: `anna@${DOMÄN}` });
  kolla('3. samma domän, hos B → B:s tråd', r.applicationId === bVolvo.id && r.inferred);
  r = await iA({ fromAddr: `anna@${BARA_B}` });
  kolla('3. domän bara B skrivit till, hos A → ingen tråd', r.applicationId === null,
    r.applicationId === bBara.id ? '(kopplades till B:s ansökan)' : '');
  r = await iA({ fromAddr: `anna@${TVÅ_A}` });
  kolla('4. två av A:s egna ansökningar på domänen → gissar inte', r.applicationId === null);
  r = await iA({ fromAddr: 'anna@okand.example' });
  kolla('5. ingen träff → lämnas i inkorgen', r.applicationId === null);

  let utanÄgare = null;
  try { await imap.matchReply({ fromAddr: `anna@${DOMÄN}`, references: [] }); } catch (e) { utanÄgare = e; }
  kolla('matchning utan brevlådans ägare vägras', Boolean(utanÄgare));

  // ---------------------------------------------------------------
  // 2. Read position and where reading starts
  // ---------------------------------------------------------------
  if (finns('läsposition', imap.läsposition) && finns('sparaLäsposition', imap.sparaLäsposition)) {
    await imap.sparaLäsposition(A, 'INBOX', 7, 100);
    await imap.sparaLäsposition(B, 'INBOX', 7, 5);
    await imap.sparaLäsposition(A, 'INBOX', 7, 50); // never backwards
    const [pa, pb, pc] = await Promise.all([A, B, C].map((p) => imap.läsposition(p, 'INBOX')));
    kolla('2. A och B har var sin läsposition',
      Number(pa?.last_seen_uid) === 100 && Number(pb?.last_seen_uid) === 5,
      `A=${pa?.last_seen_uid} B=${pb?.last_seen_uid}`);
    kolla('2. C har ingen position förrän C:s brevlåda läst', pc === null);
  }
  if (finns('förstaBrevet', imap.förstaBrevet)) {
    const [fa, fb, fc] = await Promise.all([A, B, C].map((p) => imap.förstaBrevet(p)));
    const dagar = (d) => Math.round((Date.now() - new Date(d).getTime()) / 86_400_000);
    kolla('2. A läser från A:s första brev, inte B:s', fa && dagar(fa) === 10, `A=${fa && dagar(fa)} dagar`);
    kolla('2. B läser från B:s första brev', fb && dagar(fb) === 3, `B=${fb && dagar(fb)} dagar`);
    kolla('2. C har inget brev, och läser därför ingenting', fc === null);
  }

  // ---------------------------------------------------------------
  // 3. The Sent pass
  // ---------------------------------------------------------------
  if (finns('attLetaIskickat', imap.attLetaIskickat)) {
    const stuckB = await ansökan(B, `fastnat@${DOMÄN}`, { status: 'sending' });
    const listaA = await imap.attLetaIskickat(A);
    const listaB = await imap.attLetaIskickat(B);
    const idn = (l) => [...l.trådar, ...l.fastnade].map((t) => t.id);
    kolla('3. A:s Skickat söks bara efter A:s trådar',
      !idn(listaA).includes(bVolvo.id) && !idn(listaA).includes(stuckB.id));
    kolla('3. B:s Skickat söks efter B:s tråd och fastnade brev',
      idn(listaB).includes(bVolvo.id) && idn(listaB).includes(stuckB.id));
    const kopia = { messageId: `<kopia-${KÖRNING}@proof>`, date: new Date(), subject: 'Ansökan', text: 'Hej' };
    let lagad = 'fel';
    try { lagad = await imap.repareraSending(kopia, `fastnat@${DOMÄN}`, 1, A); } catch { lagad = 'fel'; }
    kolla('3. B:s fastnade brev lagas inte från A:s Skickat', lagad === null);
    kolla('3. men från B:s', await imap.repareraSending(kopia, `fastnat@${DOMÄN}`, 1, B) === stuckB.id);
  }

  // ---------------------------------------------------------------
  // 4. A password Gmail no longer accepts
  // ---------------------------------------------------------------
  if (finns('brevlåda', imap.brevlåda)) {
    const vägrar = () => ({
      on() {}, async logout() {}, close() {},
      async connect() {
        throw Object.assign(new Error('Invalid credentials (Failure)'), { authenticationFailed: true });
      },
    });
    const utfall = await Promise.race([
      imap.brevlåda(A, { klient: vägrar, paus: async () => {} }).kör(),
      new Promise((ok) => setTimeout(() => ok('hängde'), 10_000)),
    ]);
    const { rows: [pa] } = await pool.query(
      `SELECT gmail_verified_at, gmail_error FROM profile WHERE id = $1`, [A]);
    kolla('4. fel lösenord flera gånger → brevlådan slutar', utfall === 'lösenord', `utfall: ${utfall}`);
    kolla('4. profilen avmarkeras och felet sparas', pa.gmail_verified_at === null && Boolean(pa.gmail_error));

    let försök = 0;
    const låda = imap.brevlåda(B, {
      paus: async () => {},
      klient: () => ({
        on() {}, async logout() {}, close() {},
        async connect() {
          försök += 1;
          if (försök >= 6) låda.stoppa();
          throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        },
      }),
    });
    const nät = await Promise.race([låda.kör(), new Promise((ok) => setTimeout(() => ok('hängde'), 10_000))]);
    const { rows: [pb] } = await pool.query(`SELECT gmail_verified_at FROM profile WHERE id = $1`, [B]);
    kolla('4. nätverksfel → fortsätter försöka, profilen orörd',
      nät === 'stoppad' && försök >= 6 && pb.gmail_verified_at !== null, `${försök} försök, utfall ${nät}`);
    await pool.query(`UPDATE profile SET gmail_verified_at = now(), gmail_error = NULL WHERE id = $1`, [A]);
  }

  // ---------------------------------------------------------------
  // 5. The manager
  // ---------------------------------------------------------------
  if (typeof postansvarig !== 'function') {
    kolla('postansvarig finns', false, 'src/imapManager.js saknas i den här koden');
  } else {
    const startade = new Map();
    const fejk = (profileId) => {
      const l = {
        profileId, stoppad: false, synkat: 0,
        kör: () => new Promise((ok) => { l.klar = ok; }),
        stoppa() { l.stoppad = true; l.klar?.('stoppad'); },
        synka: async () => { l.synkat += 1; },
        ansluten: () => true,
      };
      startade.set(profileId, l);
      return l;
    };
    const chef = postansvarig({ skapa: fejk });
    await chef.stäm();
    kolla('5. brevlåda för A och B (Gmail + skickat brev)', startade.has(A) && startade.has(B));
    kolla('5. ingen brevlåda för C (inget brev skickat än)', !startade.has(C));

    // A presses "Hämta post"; C presses too, with no mailbox.
    for (const p of [A, C]) {
      await pool.query(
        `INSERT INTO imap_sync_requests (profile_id, requested_at, done_at) VALUES ($1, now(), NULL)
         ON CONFLICT (profile_id) DO UPDATE SET requested_at = now(), done_at = NULL, outcome = NULL`, [p]);
    }
    await chef.svaraPåKnappar();
    const { rows: svar } = await pool.query(
      `SELECT profile_id, done_at IS NOT NULL AS klar, outcome FROM imap_sync_requests
       WHERE profile_id = ANY($1)`, [[A, C]]);
    const svarFör = (p) => svar.find((s) => s.profile_id === p);
    kolla('5. A:s knapp hämtar A:s post, inte B:s',
      startade.get(A).synkat === 1 && startade.get(B).synkat === 0);
    kolla('5. A:s begäran markeras klar', svarFör(A)?.klar && svarFör(A)?.outcome === 'klar');
    kolla('5. C:s begäran lämnas åt routen, som läser själv',
      !svarFör(C)?.klar && svarFör(C)?.outcome === null && !(await harBrevlåda(C)) && await harBrevlåda(B),
      svarFör(C)?.outcome || '');
    await chef.svaraPåKnappar();
    kolla('5. en besvarad begäran körs inte igen', startade.get(A).synkat === 1);

    await pool.query(`UPDATE profile SET gmail_verified_at = NULL WHERE id = $1`, [A]);
    await ansökan(C, `jobb@${DOMÄN}`);
    const gamlaA = startade.get(A);
    await chef.stäm();
    kolla('5. A kopplar bort Gmail → A:s brevlåda stoppas', gamlaA.stoppad);
    kolla('5. B:s brevlåda rörs inte', !startade.get(B).stoppad);
    kolla('5. C skickar sitt första brev → C:s brevlåda startar', startade.has(C));
    chef.stoppa();
    kolla('5. stoppa() stänger alla brevlådor', startade.get(B).stoppad && startade.get(C).stoppad);
  }
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  await pool.query(`DELETE FROM imap_sync_requests WHERE profile_id IN
    (SELECT id FROM profile WHERE email LIKE 'proof+imap-%-${KÖRNING}@example.invalid')`).catch(() => {});
  await städa();
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
