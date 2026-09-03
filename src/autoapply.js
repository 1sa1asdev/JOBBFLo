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

// Backstop across ALL campaigns, not a preference — the per-campaign
// limit is the preference. This exists so a misconfigured rule cannot
// mail a thousand employers overnight.
//
// The real ceiling is Gmail's: a free account is cut off around 500
// messages a day and briefly locked out, which would take the inbox
// down with it. 200 leaves room for the letters you send by hand and
// for every reply, and is far enough from the edge that a busy day
// cannot reach it by accident.
const GLOBAL_DAILY_CAP = 200;

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
// Which of the campaign's chosen places an ad belongs to.
//
// A picked name is either a kommun or a län, and the ad carries both, so
// the test differs per pick. First match wins; an ad matching none goes
// to a leftover bucket that is filled only after every quota is met.
// That bucket is not hypothetical — the pool keeps ads found under
// earlier filters, and they are still legitimate candidates.
export function bucketFor(ad, picked) {
  for (const place of picked) {
    if (/\slän$/i.test(place)) {
      if (ad.region && ad.region.toLowerCase() === place.toLowerCase()) return place;
    } else if (ad.municipality && ad.municipality.toLowerCase() === place.toLowerCase()) {
      return place;
    }
  }
  return null;
}

// Split `limit` letters across places by weight, then fill each place
// with its best-scoring candidates.
//
// Largest-remainder rather than plain rounding: with 3 letters split
// 2:1, rounding each independently gives 2 and 1 by luck and 2 and 0 or
// 2 and 1 depending on the arithmetic. Largest-remainder always hands
// out exactly `limit` slots, which is what makes the daily number mean
// something.
//
// A place that cannot fill its quota gives the remainder back rather
// than wasting it — the ratio is a preference about how to spend the
// letters, not a reason to send fewer.
export function allocateByRatio(candidates, picked, ratio, limit) {
  if (!ratio || !picked?.length) return candidates.slice(0, limit);

  const weights = picked
    .map((p) => [p, Number(ratio[p]) || 0])
    .filter(([, w]) => w > 0);
  if (!weights.length) return candidates.slice(0, limit);

  const totalWeight = weights.reduce((n, [, w]) => n + w, 0);

  const buckets = new Map(weights.map(([p]) => [p, []]));
  const leftover = [];
  for (const c of candidates) {
    const b = bucketFor(c, weights.map(([p]) => p));
    if (b) buckets.get(b).push(c); else leftover.push(c);
  }

  const exact = weights.map(([p, w]) => ({ place: p, want: (limit * w) / totalWeight }));
  const quota = new Map(exact.map((e) => [e.place, Math.floor(e.want)]));
  let slots = limit - [...quota.values()].reduce((a, b) => a + b, 0);
  for (const e of [...exact].sort((a, b) => (b.want % 1) - (a.want % 1))) {
    if (slots <= 0) break;
    quota.set(e.place, quota.get(e.place) + 1);
    slots -= 1;
  }

  const picked_out = [];
  for (const [place, list] of buckets) {
    picked_out.push(...list.slice(0, quota.get(place)));
  }

  // Unused slots go to whoever still has candidates, best score first.
  if (picked_out.length < limit) {
    const taken = new Set(picked_out.map((c) => c.ad_id));
    const rest = [...candidates, ...leftover]
      .filter((c) => !taken.has(c.ad_id))
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    picked_out.push(...rest.slice(0, limit - picked_out.length));
  }

  return picked_out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

export async function candidatesFor(searchId, { limit = 10 } = {}) {
  const { rows } = await pool.query(
    `SELECT r.ad_id, r.score, r.title, r.employer, a.apply_email, a.deadline,
       -- needed to bucket an ad by the campaign's chosen places
       a.municipality, a.raw->'workplace_address'->>'region' AS region
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
       -- A verdict, once paid for, is never ignored: a scored ad must
       -- clear the threshold either way. What the toggle changes is
       -- whether an UNJUDGED ad may go out at all — with it off the API
       -- filters are the only thing standing between the criteria and a
       -- letter, which is cheap and blunt, and the point of the setting.
       AND (r.score >= s.auto_apply_min_score
            OR (NOT s.auto_apply_require_score AND r.score IS NULL))
       -- a repost carries a new ad id but the same fingerprint;
       -- applying again would be a second letter for one job
       AND NOT EXISTS (
         SELECT 1 FROM applications ap
         JOIN ads prev ON prev.id = ap.ad_id
         WHERE ap.profile_id = pr.id AND prev.fingerprint = a.fingerprint
       )
       -- Never a second letter to an address already written to, by
       -- ANY route. The old version checked sent_by = 'auto' only, so a
       -- campaign would happily mail a recruiter the user had already
       -- contacted by hand — and a fresh ad from that recruiter carries
       -- a new ad_id, so the per-ad guard never saw it either.
       AND NOT EXISTS (
         SELECT 1 FROM applications ap2
         WHERE ap2.profile_id = pr.id AND ap2.sent_to IS NOT NULL
           AND lower(ap2.sent_to) = lower(a.apply_email)
       )
     -- NULLS LAST is load-bearing now that unscored ads can appear here:
     -- a plain score DESC sorts NULLs FIRST in Postgres, which would put
     -- every unjudged ad ahead of every high-scoring one and spend the
     -- daily limit on exactly the ads nobody vouched for.
     ORDER BY r.score DESC NULLS LAST, a.deadline ASC NULLS LAST
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

  // ----------------------------------------------------------
  // Ask for the verdicts this campaign needs.
  //
  // Scoring is gated on score_requested_at: nothing is judged until a
  // human asks, which is what stops this branch paying to read
  // thousands of ads nobody cares about. A campaign never clicks that
  // button, so a campaign requiring a score had no way to ever obtain
  // one — the first real campaign here found 600 ads, 35 of them
  // mailable, 0 scored, and would have sat there indefinitely.
  //
  // A campaign IS that request, made once and standing: the user
  // approved a rule saying "evaluate ads like this and write to them".
  // So it queues its own, and only ever ads it could actually send to —
  // an ad with no address is one it cannot use, and paying to judge it
  // would be the exact waste the gate exists to prevent.
  //
  // Asked for in a batch a few times the day's room, because most
  // candidates fall below the threshold. The daily score budget still
  // applies; anything over it simply waits for tomorrow.
  if (search.auto_apply_require_score && !dryRun) {
    // Which ads to spend the verdicts on. This LIMIT used to have no
    // ORDER BY at all, so it picked whichever rows Postgres handed back
    // — out of 600 found and 35 mailable, the 35 judged were an
    // accident of storage order.
    //
    // Ranked by embedding distance when the search has a query vector:
    // pgvector's <=> is cosine distance, so ASC is most-similar-first,
    // and the CV+criteria vector is a far better guess at "worth paying
    // to read" than nothing at all. Ads with no embedding sort last
    // rather than dropping out — unranked is not disqualified, and the
    // pool is only ~half embedded.
    const ranked = search.query_embedding
      ? `ORDER BY (a.embedding IS NULL),
                  a.embedding <=> $3::vector,
                  a.published_at DESC NULLS LAST`
      : `ORDER BY a.published_at DESC NULLS LAST`;

    const args = [searchId, Math.max(room * 5, 20)];
    if (search.query_embedding) args.push(search.query_embedding);

    const { rowCount: asked } = await pool.query(
      `UPDATE match_results m SET score_requested_at = now(), queued_at = now()
       WHERE m.search_id = $1
         AND m.score IS NULL
         AND m.score_requested_at IS NULL
         AND m.ad_id IN (
           SELECT r.ad_id FROM search_results r JOIN ads a ON a.id = r.ad_id
           WHERE r.search_id = $1 AND NOT r.suppressed
             AND a.apply_email IS NOT NULL
             AND a.removed_at IS NULL
             AND (a.deadline IS NULL OR a.deadline >= current_date)
             AND r.application_status IS NULL
           ${ranked}
           LIMIT $2
         )`,
      args
    );
    if (asked) {
      console.log(`kampanj "${search.name}": begärde bedömning av ${asked} annonser`
        + (search.query_embedding ? ' (rankade efter CV-likhet)' : ''));
    }
  }

  // Fetch a wider pool than `room` so the ratio has something to choose
  // between. Asking for exactly `room` rows returns the top scores
  // globally, which in a multi-city campaign are all from the largest
  // city — and no allocation can recover a place that was never read.
  const pool_ = await candidatesFor(searchId, {
    limit: search.location_ratio ? Math.max(room * 20, 100) : room,
  });
  const candidates = allocateByRatio(
    pool_, search.location || [], search.location_ratio, room);
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

      // One letter per address from a campaign — and it counts letters
      // the USER sent by hand too, so a campaign never writes to a
      // recruiter already contacted. (The reverse is allowed: a manual
      // letter to an address a campaign used is the user's call.)
      // The DB backs the auto-vs-auto half of this with
      // applications_auto_one_per_address; this check is what catches
      // the manual-then-auto case, which no index covers, and avoids
      // creating a row that would violate the index anyway.
      const { rows: [dupe] } = await pool.query(
        `SELECT 1 FROM applications
         WHERE profile_id = $1 AND id <> $2 AND sent_to IS NOT NULL
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
