import { pool } from './db.js';
import { brevlåda } from './imap.js';

// ------------------------------------------------------------
// One mailbox per user, kept in step with who should have one.
//
// The worker used to run a single IMAP loop for "the one profile",
// which refused to start the moment there were two. Now this keeps a
// mailbox (src/imap.js brevlåda) for every user who has connected Gmail
// AND sent at least one letter through the app — before that first
// letter there is nothing in their mail that is the app's business, so
// no connection is opened at all.
//
// Once a minute the list is compared with what is running: a user who
// connects Gmail or sends their first letter gets a mailbox within a
// minute, one who disconnects is closed. Each mailbox reconnects on its
// own, so one user's dead connection or revoked password touches nobody
// else.
//
// The "Hämta post" button is answered here too: one query every three
// seconds for everyone, rather than one per mailbox, and it wakes only
// the mailbox of the user who pressed it.
//
// Scale: Gmail allows 15 IMAP connections per account, and this uses
// one per user. A Node process holds hundreds of idle connections; past
// that, users get split across several workers, which this shape — one
// place that hands out mailboxes — makes a matter of filtering the list.
// ------------------------------------------------------------

const STÄM_VAR = 60 * 1000;
const KNAPP_VAR = 3000;

// Who should have a mailbox. A stored password that Gmail accepted, and
// a letter sent (or handed to Gmail) through the app.
const SKA_BEVAKAS = `
  p.gmail_verified_at IS NOT NULL
  AND p.gmail_app_password_enc IS NOT NULL
  AND EXISTS (SELECT 1 FROM applications a
              WHERE a.profile_id = p.id
                AND (a.sent_at IS NOT NULL OR a.sending_since IS NOT NULL))`;

async function vilkaSkaBevakas() {
  const { rows } = await pool.query(`SELECT p.id FROM profile p WHERE ${SKA_BEVAKAS}`);
  return new Set(rows.map((r) => r.id));
}

// For the "Hämta post" route: is there a mailbox in the worker worth
// waiting for? If not, the route reads directly instead of waiting out
// a timeout for an answer nobody will give.
export async function harBrevlåda(profileId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM profile p WHERE p.id = $1 AND ${SKA_BEVAKAS}`, [profileId]);
  return rows.length > 0;
}

// skapa is there so the proof can hand out fake mailboxes.
export function postansvarig({ skapa = brevlåda } = {}) {
  const lådor = new Map();
  const körningar = new Set();
  const timrar = [];
  let stoppad = false;

  function starta(profileId) {
    const låda = skapa(profileId);
    lådor.set(profileId, låda);
    const körning = Promise.resolve()
      .then(() => låda.kör())
      .then((utfall) => {
        // Ended on its own — a refused password, say. Forgotten, so a
        // new password brings it back at the next comparison.
        if (utfall && utfall !== 'stoppad') console.log(`imap: brevlådan för ${profileId} stängd (${utfall})`);
      })
      .catch((err) => console.error(`imap: brevlådan för ${profileId} kraschade:`, err.message))
      .finally(() => {
        if (lådor.get(profileId) === låda) lådor.delete(profileId);
        körningar.delete(körning);
      });
    körningar.add(körning);
  }

  async function stäm() {
    if (stoppad) return;
    const ska = await vilkaSkaBevakas();
    for (const [profileId, låda] of lådor) {
      if (!ska.has(profileId)) {
        lådor.delete(profileId);
        låda.stoppa();
      }
    }
    for (const profileId of ska) {
      if (!lådor.has(profileId)) starta(profileId);
    }
  }

  // One row per user who pressed the button, and only the users this
  // manager keeps a mailbox for — a press by anyone else is not this
  // process's to answer (the route reads those itself). Claimed with a
  // marker so a slow fetch is not started twice by the next tick, and
  // stamped done only for the request it answered: a press that arrived
  // in the meantime stays open for the next tick.
  //
  // requested_at goes round as text. Through a JS Date it loses its
  // microseconds and the "this request" match below never matched.
  async function svaraPåKnappar() {
    // How the route knows whether anyone is listening at all. Belongs
    // to the process, not to any user.
    await pool.query(
      `INSERT INTO poll_state (key, last_run_at) VALUES ('imap_worker_alive', now())
       ON CONFLICT (key) DO UPDATE SET last_run_at = now()`);
    if (!lådor.size) return;
    const { rows } = await pool.query(
      `UPDATE imap_sync_requests SET outcome = 'pågår'
       WHERE done_at IS NULL AND outcome IS DISTINCT FROM 'pågår'
         AND profile_id = ANY($1::uuid[])
       RETURNING profile_id, requested_at::text AS begärd`, [[...lådor.keys()]]);
    await Promise.all(rows.map(async ({ profile_id: profileId, begärd }) => {
      const låda = lådor.get(profileId);
      let utfall = 'klar';
      if (!låda || !låda.ansluten()) {
        // Reconnecting, or closed since the claim: the route reads the
        // mailbox itself rather than waiting on this one.
        utfall = 'ingen brevlåda';
      } else {
        try {
          await låda.synka();
        } catch (err) {
          utfall = `fel: ${err.message}`.slice(0, 300);
        }
      }
      await pool.query(
        `UPDATE imap_sync_requests SET done_at = now(), outcome = $3
         WHERE profile_id = $1 AND requested_at = $2::timestamptz`, [profileId, begärd, utfall]);
    }));
  }

  function start() {
    const stämSäkert = () => stäm().catch((e) => console.error('imap-stäm:', e.message));
    const knappSäkert = () => svaraPåKnappar().catch((e) => console.error('sync-begäran:', e.message));
    stämSäkert();
    timrar.push(setInterval(stämSäkert, STÄM_VAR));
    timrar.push(setInterval(knappSäkert, KNAPP_VAR));
  }

  // Closes every mailbox and waits (briefly) for them to say goodbye.
  async function stoppa() {
    stoppad = true;
    for (const t of timrar) clearInterval(t);
    for (const låda of lådor.values()) låda.stoppa();
    lådor.clear();
    await Promise.race([
      Promise.allSettled([...körningar]),
      new Promise((klar) => { setTimeout(klar, 5000).unref?.(); }),
    ]);
  }

  return { start, stäm, svaraPåKnappar, stoppa, antal: () => lådor.size };
}
