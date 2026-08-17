-- ============================================================
-- JOBBFLO — schema
-- Core rule: ads are GLOBAL, match_results are PER-SEARCH,
-- applications are PER-AD. This is what prevents the CRM-E
-- problem where a new search didn't know an ad was applied to.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- users: login identity. One account = one profile.
-- ------------------------------------------------------------
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  password_hash   text NOT NULL,              -- scrypt$N$salt$hash
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- profile: the user + their base CV. user_id is nullable so a
-- seeded profile can be claimed by signing up with its email.
-- ------------------------------------------------------------
CREATE TABLE profile (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  email           text NOT NULL,              -- gmail used for SMTP/IMAP
  phone           text,
  city            text,

  cv_filename     text,
  cv_text         text,
  -- The CV read ONCE by the best model available, not re-derived inside
  -- every scoring and letter call. Every fact carries verbatim evidence
  -- from cv_text, same invariant as the ad quotes (#5), so a misreading
  -- is visible and correctable in one place instead of a thousand.
  cv_profile      jsonb,
  cv_profile_at   timestamptz,
  cv_profile_model text,           -- a weak model's reading should be rebuilt                       -- extracted plain text
  cv_parsed       jsonb,                      -- {tech:[], experience:[], languages:[]}

  about_text      text,                       -- "om dig, i egna ord"
  tone_text       text,                       -- letter tone preferences

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- projects: used for project-to-ad matching
-- letter generator picks which one to lead with per ad
-- ------------------------------------------------------------
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  name            text NOT NULL,
  summary         text NOT NULL,              -- one paragraph, used in letters
  tech            text[] NOT NULL DEFAULT '{}',
  url             text,
  is_active       boolean NOT NULL DEFAULT true
);

-- ------------------------------------------------------------
-- searches: each saved search = one AI conversation
-- ------------------------------------------------------------
CREATE TABLE searches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  name            text NOT NULL,

  criteria_text   text NOT NULL,              -- user's own words, drives layer 2
  api_filters     jsonb NOT NULL DEFAULT '{}',-- parsed layer-1 filters

  email_alias     text,                       -- din+frontend@gmail.com

  -- Which application methods are worth a scoring call: email | any |
  -- external. Enforced at QUEUE time in src/score.js, before any LLM
  -- call — filtering the list afterwards would cost exactly the same
  -- as no filter. NULL means "user not asked yet" and reads as 'any',
  -- which is what lets the copilot ask exactly once per search.
  -- Campaigns are created as 'email': auto-apply can only send to an
  -- address, so judging link-only ads buys unusable verdicts.
  apply_filter    text CHECK (apply_filter IN ('email','any','external')),

  -- Finding is free, so a search walks its whole JobSearch result set
  -- instead of re-reading page one. The cursor advances each scan and
  -- wraps to 0 when exhausted, picking up newly published ads.
  fetch_offset    int NOT NULL DEFAULT 0,
  fetch_total     int,
  fetch_done_at   timestamptz,
  -- filters JobSearch rejected outright (0 hits) and the broadening
  -- ladder removed. Surfaced in the UI: a silently-ignored requirement
  -- is indistinguishable from a filter that does not work.
  dropped_filters text[],

  scan_enabled    boolean NOT NULL DEFAULT true,
  scan_interval   interval NOT NULL DEFAULT '1 hour',
  last_scanned_at timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz                 -- soft delete: inbox back-refs
);                                            -- must survive deletion

CREATE TABLE search_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id       uuid NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant','system')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- ads: GLOBAL. one row per real-world posting, whatever
-- search found it and whatever source it came from.
-- ------------------------------------------------------------
CREATE TABLE ads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source          text NOT NULL CHECK (source IN ('platsbanken','linkedin','academicwork','manual')),
  external_id     text,                       -- AF ad id. NULL for pasted ads.

  -- soft-dedupe key: catches reposts + cross-source duplicates.
  -- deliberately EXCLUDES deadline, since that's what changes on repost.
  fingerprint     text NOT NULL,

  title           text NOT NULL,
  employer        text NOT NULL,
  employer_type   text,                       -- agency|public|private|unknown -> response priors
  municipality    text,
  region          text,

  description     text NOT NULL,
  apply_email     text,
  apply_url       text,
  ats_vendor      text,                       -- teamtailor|varbi|workday|reachmee|null

  published_at    timestamptz,
  deadline        date,
  removed_at      timestamptz,                -- JobStream tells us when it's gone

  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- hard dedupe: same source + same external id is the same ad, always
CREATE UNIQUE INDEX ads_source_external ON ads(source, external_id)
  WHERE external_id IS NOT NULL;

-- soft dedupe: looked up, but NOT unique — flag, don't merge silently
CREATE INDEX ads_fingerprint ON ads(fingerprint);
CREATE INDEX ads_deadline ON ads(deadline) WHERE removed_at IS NULL;

-- ------------------------------------------------------------
-- match_results: PER-SEARCH. same ad scores differently
-- in different searches, and that's correct.
--
-- A row is created the moment layer 1 selects the ad, with score
-- NULL meaning "queued, not judged yet". That split is what lets the
-- UI list jobs a second after the user asks instead of waiting out a
-- whole batch of LLM calls — see db/migrations/011_pending_matches.
-- It does not weaken the per-search rule: still one row per
-- (search x ad), and the pending row IS the row that later gets its
-- score, not a second one.
-- ------------------------------------------------------------
CREATE TABLE match_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id       uuid NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  ad_id           uuid NOT NULL REFERENCES ads(id) ON DELETE CASCADE,

  -- NULL until judged. The CHECK still constrains a real score:
  -- with NULL it evaluates to NULL, which a CHECK accepts.
  score           int CHECK (score BETWEEN 0 AND 100),
  summary         text,                       -- one-line reasoning shown in list
  matched         jsonb NOT NULL DEFAULT '[]',-- [{quote, why}] -> ad-text highlights
  flags           jsonb NOT NULL DEFAULT '[]',-- [{quote, why}] -> feeds skills-gap report
  lead_project_id uuid REFERENCES projects(id),

  queued_at       timestamptz NOT NULL DEFAULT now(),
  -- Two human gates before any spend. Favouriting says "interesting"
  -- and is free; requesting a score is a separate, deliberate act on
  -- specific ads and is the ONLY thing src/score.js will act on.
  shortlisted_at     timestamptz,             -- user favourited it
  score_requested_at timestamptz,             -- user asked for a verdict
  scored_at       timestamptz,                -- NULL while queued
  queue_rank      real,                       -- prefilter confidence; drains best-first
  attempts        int NOT NULL DEFAULT 0,     -- one bad ad must not wedge the queue
  last_error      text,
  UNIQUE (search_id, ad_id)                   -- never score the same ad twice per search
);

CREATE INDEX match_results_score ON match_results(search_id, score DESC);
-- the drain hits this constantly; partial so it stays tiny
CREATE INDEX match_results_pending
  ON match_results (search_id, queue_rank DESC NULLS LAST)
  WHERE score IS NULL;

-- ------------------------------------------------------------
-- applications: PER-(USER, AD). this UNIQUE is the whole fix.
-- a second search physically cannot create a second
-- application for an ad the user already applied to.
-- ------------------------------------------------------------
CREATE TABLE applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id           uuid NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profile(id) ON DELETE CASCADE,

  -- which search produced it: for the inbox "find similar jobs" button.
  -- ON DELETE SET NULL + searches.deleted_at means the back-reference
  -- degrades to "sökning borttagen" instead of breaking.
  origin_search_id uuid REFERENCES searches(id) ON DELETE SET NULL,

  status          text NOT NULL DEFAULT 'drafted'
                  CHECK (status IN ('drafted','sent','replied','interview','rejected','ghosted','withdrawn')),

  subject         text,
  letter_text     text,
  letter_version  int NOT NULL DEFAULT 1,

  message_id      text UNIQUE,                -- RFC Message-ID of what we sent
  sent_to         text,
  sent_from       text,                       -- the plus-alias used
  sent_at         timestamptz,

  followup_enabled boolean NOT NULL DEFAULT false,
  followup_days    int NOT NULL DEFAULT 10,
  followup_sent_at timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, ad_id)
);

CREATE INDEX applications_status ON applications(status);
CREATE INDEX applications_message_id ON applications(message_id);

-- letter version history for the undo/redo in the revision chat
CREATE TABLE letter_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  version         int NOT NULL,
  subject         text,
  body            text NOT NULL,
  change_note     text,                       -- "kortat stycke 2 från 5 till 2 meningar"
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, version)
);

-- ------------------------------------------------------------
-- email_messages: the thread. both directions.
-- ------------------------------------------------------------
CREATE TABLE email_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

  direction       text NOT NULL CHECK (direction IN ('outbound','inbound')),
  message_id      text,                       -- RFC Message-ID
  in_reply_to     text,
  references_ids  text[],

  from_addr       text NOT NULL,
  from_name       text,
  to_addr         text,
  subject         text,
  body_text       text,

  imap_uid        bigint,                     -- for catch-up-since-lastSeenUid
  sent_at         timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_messages_app ON email_messages(application_id, sent_at);
CREATE INDEX email_messages_msgid ON email_messages(message_id);
CREATE INDEX email_messages_inreplyto ON email_messages(in_reply_to);

-- AI-suggested replies, never auto-sent
CREATE TABLE suggested_replies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  reply_to_id     uuid REFERENCES email_messages(id) ON DELETE CASCADE,
  body            text NOT NULL,
  kind            text NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','followup')),
  dismissed       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- interview prep, generated when status hits 'interview'
CREATE TABLE interview_prep (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  questions       jsonb NOT NULL DEFAULT '[]',
  claimed_note    text,
  gaps            jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- never_apply: keyed on FINGERPRINT, not ad_id, so a repost
-- with a fresh external_id stays suppressed.
-- ------------------------------------------------------------
CREATE TABLE never_apply (
  fingerprint     text PRIMARY KEY,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- poll_state: one global JobStream cursor. all searches score
-- against the shared pool — never one fetch per search.
-- ------------------------------------------------------------
CREATE TABLE poll_state (
  key             text PRIMARY KEY,
  cursor_ts       timestamptz,
  last_run_at     timestamptz,
  note            text
);

INSERT INTO poll_state (key, cursor_ts) VALUES ('jobstream', now() - interval '1 day')
  ON CONFLICT DO NOTHING;
INSERT INTO poll_state (key, note) VALUES ('imap', 'lastSeenUid stored in cursor_ts=null, see imap_state')
  ON CONFLICT DO NOTHING;

CREATE TABLE imap_state (
  mailbox         text PRIMARY KEY,
  uid_validity    bigint,
  last_seen_uid   bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- THE QUERY THAT FIXES CRM-E
-- Application status is a JOIN, not a sync. Same ad in two
-- searches: two scores, one status.
-- ============================================================
CREATE VIEW search_results AS
SELECT
  m.search_id,
  a.id            AS ad_id,
  a.title,
  a.employer,
  a.municipality,
  a.deadline,
  a.ats_vendor,
  m.score,
  m.summary,
  m.flags,
  (m.score IS NULL) AS pending,   -- "not judged yet", not "judged as 0"
  m.queued_at,
  m.attempts,
  m.last_error,
  app.status      AS application_status,
  app.sent_at,
  app.origin_search_id,
  (app.id IS NOT NULL AND m.search_id <> app.origin_search_id) AS applied_via_other_search,
  (na.fingerprint IS NOT NULL) AS suppressed
FROM match_results m
JOIN searches s      ON s.id = m.search_id
JOIN ads a           ON a.id = m.ad_id
LEFT JOIN applications app ON app.ad_id = a.id AND app.profile_id = s.profile_id
LEFT JOIN never_apply na   ON na.fingerprint = a.fingerprint
WHERE a.removed_at IS NULL;
