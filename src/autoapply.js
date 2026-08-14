import { pool } from './db.js';
import { renderCampaignLetter } from './campaign.js';
import { sendApplication, attachmentsFor } from './mailer.js';

// ------------------------------------------------------------
// Auto-apply campaigns.
//
// The user approves a RULE, not each letter: "in this search, apply
// to anything scoring >= N, at most M per day". That is a deliberate
// replacement for CLAUDE.md's per-send gate, so everything here is
// built to be conservative, auditable and stoppable:
//
//   - only ads that PUBLISH an apply_email (we never guess one)
//   - only when a CV file exists to attach (the ad asked for one)
//   - highest score first, so the daily budget goes to best matches
//   - one application per ad, ever (UNIQUE(profile_id, ad_id))
//   - a send failure PAUSES the campaign instead of retrying, so a
//     broken config can't spray a hundred employers
//   - every decision is written to auto_apply_log, including skips
// ------------------------------------------------------------

const GLOBAL_DAILY_CAP = 20;   // backstop across all searches

// A Postgres advisory lock, so two runs can never overlap: the worker
// tick, a UI trigger and a second worker process all serialise here.
// Without it, two runs can both read "not applied yet" for the same ad
// before either inserts — the one race the UNIQUE index would turn
// into a crash mid-campaign rather than a clean skip.
const LOCK_KEY = 8123471;

async function withLock(fn) {
  const client = await pool.connect();
  try {
    const { rows: [{ locked }] } = await client.query(
      `SELECT pg_try_advisory_lock($1) AS locked`, [LOCK_KEY]);
    if (!locked) return { sent: 0, skipped: [], reason: 'en körning pågår redan' };
    try {
      return await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function log(entry) {
  await pool.query(
    `INSERT INTO auto_apply_log (search_id, ad_id, application_id, score, outcome, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [entry.searchId || null, entry.adId || null, entry.applicationId || null,
     entry.score ?? null, entry.outcome, entry.detail || null]
  );
}

async function pause(searchId, reason) {
  await pool.query(
    `UPDATE searches SET auto_apply_enabled = false, auto_apply_paused_reason = $2 WHERE id = $1`,
    [searchId, reason]
  );
}

async function sentToday() {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM applications
     WHERE sent_by = 'auto' AND sent_at > date_trunc('day', now())`
  );
  return r.n;
}

// ------------------------------------------------------------
// Which ads qualify right now, best match first.
// ------------------------------------------------------------
export async function candidatesFor(searchId, { limit = 10 } = {}) {
  const { rows } = await pool.query(
    `SELECT r.ad_id, r.score, r.title, r.employer, a.apply_email, a.deadline
     FROM search_results r
     JOIN ads a ON a.id = r.ad_id
     JOIN searches s ON s.id = r.search_id
     JOIN profile pr ON pr.id = s.profile_id
     WHERE r.search_id = $1
       AND r.application_status IS NULL          -- never applied to
       AND NOT r.suppressed
       AND a.apply_email IS NOT NULL             -- the ad invites email
       AND a.removed_at IS NULL
       AND (a.deadline IS NULL OR a.deadline >= current_date)
       AND r.score >= s.auto_apply_min_score
       -- a repost carries a new ad id but the same fingerprint;
       -- applying again would be a second letter for one job
       AND NOT EXISTS (
         SELECT 1 FROM applications ap
         JOIN ads prev ON prev.id = ap.ad_id
         WHERE ap.profile_id = pr.id AND prev.fingerprint = a.fingerprint
       )
       -- and never a second auto-mail to an address already contacted
       AND NOT EXISTS (
         SELECT 1 FROM applications ap2
         WHERE ap2.profile_id = pr.id AND ap2.sent_by = 'auto'
           AND lower(ap2.sent_to) = lower(a.apply_email)
       )
     ORDER BY r.score DESC, a.deadline ASC NULLS LAST
     LIMIT $2`,
    [searchId, limit]
  );
  return rows;
}

// ------------------------------------------------------------
// Run one search's campaign. dryRun reports what WOULD be sent.
// ------------------------------------------------------------
export async function runAutoApply(searchId, opts = {}) {
  // a dry run reads only, so it needs no lock and must never block
  return opts.dryRun ? runAutoApplyInner(searchId, opts)
                     : withLock(() => runAutoApplyInner(searchId, opts));
}

async function runAutoApplyInner(searchId, { dryRun = false } = {}) {
  const { rows: [search] } = await pool.query(
    `SELECT s.*, p.id AS profile_id, octet_length(COALESCE(s.cv_file, p.cv_file)) AS cv_bytes
     FROM searches s JOIN profile p ON p.id = s.profile_id
     WHERE s.id = $1 AND s.deleted_at IS NULL`, [searchId]
  );
  if (!search) return { sent: 0, skipped: [], reason: 'sökningen finns inte' };
  if (!dryRun && !search.auto_apply_enabled) return { sent: 0, skipped: [], reason: 'avstängd' };

  // the whole point of a campaign: ONE letter the user has read.
  // Editing the letter clears the approval, so this also stops a
  // campaign that was changed but not re-read.
  if (!search.campaign_letter?.trim()) {
    const reason = 'inget kampanjbrev skrivet än';
    if (!dryRun) await log({ searchId, outcome: 'skipped', detail: reason });
    return { sent: 0, skipped: [], reason };
  }
  if (!search.campaign_letter_approved_at) {
    const reason = 'brevet är inte godkänt — läs och godkänn det först';
    if (!dryRun) { await pause(searchId, reason); await log({ searchId, outcome: 'skipped', detail: reason }); }
    return { sent: 0, skipped: [], reason };
  }

  // an application without the CV the ad asked for is worse than none
  if (!search.cv_bytes) {
    const reason = 'inget CV-dokument att bifoga — ladda upp CV som fil';
    if (!dryRun) { await pause(searchId, reason); await log({ searchId, outcome: 'skipped', detail: reason }); }
    return { sent: 0, skipped: [], reason };
  }

  const globalToday = await sentToday();
  const { rows: [t] } = await pool.query(
    `SELECT count(*)::int AS n FROM applications a
     WHERE a.sent_by = 'auto' AND a.origin_search_id = $1
       AND a.sent_at > date_trunc('day', now())`, [searchId]
  );
  const room = Math.min(
    search.auto_apply_daily_limit - t.n,
    GLOBAL_DAILY_CAP - globalToday
  );
  if (room <= 0) return { sent: 0, skipped: [], reason: 'dagsgränsen nådd' };

  const candidates = await candidatesFor(searchId, { limit: room });
  const results = { sent: 0, sentTo: [], skipped: [], dryRun };

  for (const c of candidates) {
    if (dryRun) {
      results.sentTo.push({ score: c.score, title: c.title, employer: c.employer, to: c.apply_email });
      results.sent++;
      continue;
    }
    try {
      const subject = renderCampaignLetter(search.campaign_subject);
      const body = renderCampaignLetter(search.campaign_letter);

      // DO NOTHING, never DO UPDATE: an application already existing
      // for this ad means it was applied to (or drafted by hand), and
      // overwriting it would both destroy that draft and risk a second
      // letter. No row back = someone else has this ad; skip it.
      const { rows: [app] } = await pool.query(
        `INSERT INTO applications (ad_id, profile_id, origin_search_id, status,
           subject, letter_text, letter_version, sent_by)
         VALUES ($1,$2,$3,'drafted',$4,$5,1,'auto')
         ON CONFLICT (profile_id, ad_id) DO NOTHING
         RETURNING *`,
        [c.ad_id, search.profile_id, searchId, subject, body]);
      if (!app) {
        await log({ searchId, adId: c.ad_id, score: c.score, outcome: 'skipped',
                    detail: 'ansökan finns redan för annonsen' });
        results.skipped.push({ title: c.title, detail: 'redan ansökt' });
        continue;
      }

      // one address may only ever receive one auto-sent letter. The
      // DB enforces this too (applications_auto_one_per_address); this
      // check just avoids creating a row that would violate it.
      const { rows: [dupe] } = await pool.query(
        `SELECT 1 FROM applications
         WHERE profile_id = $1 AND sent_by = 'auto' AND id <> $2
           AND lower(sent_to) = lower($3) LIMIT 1`,
        [search.profile_id, app.id, c.apply_email]);
      if (dupe) {
        await pool.query(`DELETE FROM applications WHERE id = $1 AND status = 'drafted'`, [app.id]);
        await log({ searchId, adId: c.ad_id, score: c.score, outcome: 'skipped',
                    detail: `${c.apply_email} har redan fått ett automatiskt mejl` });
        results.skipped.push({ title: c.title, detail: 'adressen redan kontaktad' });
        continue;
      }

      // belt and braces: never send a letter with no CV attached
      const files = await attachmentsFor(app.id);
      if (!files.length) {
        const detail = 'ingen bilaga kunde bifogas';
        await log({ searchId, adId: c.ad_id, applicationId: app.id, score: c.score, outcome: 'skipped', detail });
        results.skipped.push({ title: c.title, detail });
        continue;
      }

      await sendApplication(app.id, { to: c.apply_email });
      await log({ searchId, adId: c.ad_id, applicationId: app.id, score: c.score,
                  outcome: 'sent', detail: `${c.employer} <${c.apply_email}>` });
      results.sent++;
      results.sentTo.push({ score: c.score, title: c.title, employer: c.employer, to: c.apply_email });
    } catch (err) {
      // A unique violation means the duplicate guard did its job —
      // another run got there first. That is the system working, not
      // a fault, so skip this ad and carry on.
      if (err.code === '23505') {
        await log({ searchId, adId: c.ad_id, score: c.score, outcome: 'skipped',
                    detail: 'dubblett stoppad av databasen' });
        results.skipped.push({ title: c.title, detail: 'dubblett stoppad' });
        continue;
      }
      // anything else stops the whole campaign — a bad key, a dead
      // SMTP session or an LLM outage will not fix itself on the next
      // employer
      const detail = err.message.slice(0, 200);
      await log({ searchId, adId: c.ad_id, score: c.score, outcome: 'failed', detail });
      await pause(searchId, `stoppad efter fel: ${detail}`);
      results.skipped.push({ title: c.title, detail });
      results.paused = true;
      break;
    }
  }
  return results;
}

export async function runAllAutoApply() {
  const { rows: searches } = await pool.query(
    `SELECT id, name FROM searches WHERE deleted_at IS NULL AND auto_apply_enabled`
  );
  const out = [];
  for (const s of searches) {
    try {
      const r = await runAutoApply(s.id);
      if (r.sent || r.skipped?.length) out.push({ search: s.name, ...r });
    } catch (err) {
      console.error(`auto-apply ${s.name}:`, err.message);
    }
  }
  return out;
}
