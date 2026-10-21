# Jobbflo

AI-assisted job search + application CRM for the Swedish market.
Single user (the developer) for now; schema designed so multi-user is
additive, not a rewrite.

## What it does

1. **Finds jobs** — one feed in, one pool. The JobStream poll and the
   daily snapshot (`janitor.js`) fill `ads`; every search then reads
   that pool with SQL filters and vector distance (`src/localsearch.js`).
   Searches never call the job API themselves — two flows of the same
   data is what this replaced. LinkedIn and Academic Work are paste-in
   only (no usable API, ToS forbids scraping).
2. **Grades them** against the CV as a checklist (`src/checklist.js`) —
   the ad's requirements read once per (ad, user), each answered against
   the CV with a verbatim quote from both sides, and the score computed
   in code from those rows. Stored per (ad, user, CV), so every search
   of theirs reuses it.
   The number must always be a sum of rows the user can read; a model
   picking a 0-100 is what this replaced.
3. **Drafts cover letters**, revised through a chat loop, sent via Gmail
   SMTP after explicit human approval.
4. **Tracks replies** via IMAP IDLE, classifies them, drafts responses.

---

## Non-negotiable invariants

Violating any of these reintroduces bugs that were specifically designed out.

### 1. Ads global, match_results per-search, applications per-ad

```
ads                one row per real-world posting
match_results      one row per (search × ad) — same ad scores
                   differently in different searches, correctly
applications       UNIQUE(ad_id) — one application per ad, ever
```

The predecessor project (CRM-E) had application state tied to the search
that found the ad, so a new search didn't know an ad had been applied to.
**The fix is a JOIN, not a sync** — see the `search_results` view in
`db/schema.sql`. Never denormalize application status onto match_results.

### 2. Nothing sends without explicit human approval

Cover letters, replies, follow-up nudges — all generate as drafts. The
approval gate is unconditional and has no "trusted" bypass. Scheduled
follow-ups schedule a *draft*, never a send.

### 3. One global JobStream poll, not one per search

All searches score against a shared ad pool. Five hourly searches must not
mean five identical API pulls. Cursor lives in `poll_state`.

### 4. Dedupe: hard on external_id, soft on fingerprint

`UNIQUE(source, external_id)` merges automatically. Fingerprint matches
(employer + title + municipality, **excluding deadline**) are *flagged for
the user*, never silently merged — hiding a job the user hasn't seen is
worse than showing a duplicate.

### 5. Quotes in scoring output must be verbatim

`matched[].quote` and `flags[].quote` are used to highlight spans in the ad
text and to link letter claims back to the requirement they answer. A
hallucinated quote breaks the UI silently. Max 15 words each.

The same rule applies to the CV side of a checklist row: an unsourced
`uppfyllt` is downgraded, because "the CV covers this" with nothing to
point at is the one failure the checklist exists to prevent.

### 6. One pool, one source

Ads enter through the feed and the snapshot; searches read the pool
(`src/localsearch.js`). A search must never query the job API for its
own results — that was two flows of the same data, and the second one
carried a cursor, an offset ceiling and filters the API had to
understand. Filters match `concept_id`, never labels: the feed and the
filter names disagree (an ad says "Tillsvidareanställning (inkl.
eventuell provanställning)" where the filter says
"Tillsvidareanställning"), and by label that filter found 588 permanent
jobs in Göteborg where the API finds 2810.

Corollary: a filter the pool cannot answer is not offered. remote,
trainee and larling are not in the feed's ad data, and a filter that
silently matches nothing is worse than no filter.

### 7. The grade is arithmetic over rows the user can read

`ad_checks.score` is computed from `ad_checks.items`, never chosen by a
model. A model may read requirements and answer them; the weighting
lives in code (`scoreFromItems`), so the same checklist always gives
the same number and re-weighting costs nothing.

The checklist is per (ad, user, CV) — not per search. "Does this CV meet
these requirements" does not depend on which search found the ad, and
paying for it twice is what the cache key prevents. A campaign's
`must_criteria` is one extra row and gets its own key, so a campaign's
private rule cannot leak into what another search sees.

Both steps belong to one user. The read (`ad_reads`) is made with that
user's model on their key, and the checklist (`ad_checks.profile_id`)
is built from it — never reused for another user, even one with the
same CV. A read that is still thin after the better model re-reads it
is stored as failed and **not graded**: the gap between reading and
grading is a quality gate, and spending on a checklist over the wrong
requirements is what it stops. `prove-ad-reads.js` holds all of this.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20+, ESM | already written this way |
| Language | TypeScript | port `src/` as you go; it's plain JS today |
| Framework | Next.js (App Router) | one repo for UI + API routes |
| DB + login | Supabase (Postgres, Auth with Google) | session pooler; RLS shuts the Data API out |
| DB access | `pg` directly, or Drizzle | schema is hand-written SQL; Drizzle if you want types |
| Styling | Tailwind | mockup is hand-CSS; tokens map cleanly |
| LLM | `@anthropic-ai/sdk` | Sonnet for scoring/letters, Haiku for fast classify |
| Email out | `nodemailer` → Gmail SMTP | app password, no OAuth |
| Email in | `imapflow` → Gmail IMAP IDLE | push, 1–3s latency |
| UI host | Vercel (`arn1`) | builds only the `staging`/`production` branches |
| Worker host | Railway (`Dockerfile`, worker + janitor) | **see below — this cannot be Vercel** |

### The one architectural constraint that matters

**IMAP IDLE needs a long-lived process. Serverless cannot do this.**

Vercel functions are request-scoped and time-limited; an IDLE connection
must stay open indefinitely. So the system is two deployables:

```
┌────────────────────┐    ┌──────────────────────┐   ┌────────────────────┐
│  Next.js (Vercel)  │    │  Worker (Railway)    │   │  Janitor           │
│  UI + API routes   │    │  long-running        │   │  slow pool hygiene │
│                    │    │                      │   │                    │
│  - chat/criteria   │    │  - IMAP IDLE loop    │   │  - daily snapshot  │
│  - list, letter UI │◄──►│  - JobStream poll    │◄─►│  - closes ads that │
│  - inbox UI        │ PG │  - scoring drain     │PG │    stopped being   │
│  - send (on click) │    │  - campaigns         │   │    published       │
└────────────────────┘    └──────────────────────┘   │  - retire + prune  │
                                                     └────────────────────┘
```

The janitor is separate because the snapshot is hundreds of megabytes
and minutes of work: inside the worker it stalls IMAP, the campaign
tick and the scoring drain while it runs.

Postgres is the only thing they share. The worker writes; the UI reads and
handles user-initiated actions. For live inbox updates, poll the API route
every few seconds or use Supabase realtime — don't try to push from the
worker to the browser directly.

Railway's free tier covers a single small always-on worker. If you'd rather
run one deployable, put everything on Railway and skip Vercel.

---

## Repo layout

```
db/
  schema.sql         GENERATED snapshot of the schema; read this first,
                     never edit it (see "Changing the schema")
  baseline.sql       frozen schema as of migration 043; fresh installs
                     start here
  migrations/        every change since, applied by scripts/migrate.js
  seed.sql           placeholder profile; your real one is seed.local.sql
src/
  db.js              pg pool
  fetchJobs.js       JobStream poll, JobSearch backfill, fingerprint,
                     ATS detection, employer-type priors
  score.js           layer 1 (criteria→filters), layer 2 (cross-reference),
                     skillsGap(), calibration()
scripts/
  tryit.js           end-to-end proof, no UI
design/
  mockup.html        static visual spec — NOT a component structure to port.
                     Hardcoded arrays. Use for layout/tokens/interactions.
```

---

## Build order

Each step is verifiable before the next. Don't skip ahead to the UI.

**1. Prove the grading** ← start here
```bash
npm run db:init && npm run db:seed && npm run try
node scripts/prove-checklist.js     # arithmetic, quote check, reuse
```
Read the checklists, not just the numbers: a wrong requirement or an
unsourced "uppfyllt" is the failure that matters, and the score is only
arithmetic over those rows. Iterate on the prompts in `src/adprofile.js`
(what the ad demands) and `src/checklist.js` (whether the CV answers it).

**2. Send one real application**
`nodemailer` + letter generation. Test to yourself, then send one real one.
Store `info.messageId` on the application row — reply matching depends on it.

**3. Close the loop**
`imapflow` IDLE + reconnect wrapper with catch-up since `last_seen_uid`.
Match replies via `In-Reply-To`, falling back to the last entry in
`References`. Then classify → status.

**4. UI**
Now port the mockup.

---

## The proofs

Seventeen scripts, each one a rule that protects money, reputation or the
user's own words. They run against the live database on throwaway rows
and send nothing, so they are safe to run any time — and they exist
because these are the failures you cannot find by looking at the UI.

```bash
node scripts/prove-checklist.js          # the grade is arithmetic over readable rows
node scripts/prove-company-cooldown.js   # one letter per company per 30 days
node scripts/prove-send-transaction.js   # a letter can never be sent twice
node scripts/prove-injection.js          # ad text cannot give the models orders
node scripts/prove-profile-scope.js      # no code picks a profile by guessing
node scripts/prove-owner-checks.js       # one user cannot reach another's rows
node scripts/prove-imap-scope.js         # one user's mail stays that user's
node scripts/prove-ad-reads.js           # each user reads ads themselves; thin reads aren't graded
node scripts/prove-rls.js                # the database answers only to the server
node scripts/prove-supabase-login.js     # Google-mode sign-in, end to end (local Supabase)
node scripts/prove-admin.js              # admin pages answer only the operator; a block stops the account
node scripts/prove-onboarding.js         # new accounts are guided in; the cost estimate is arithmetic
node scripts/prove-account.js            # export holds all of a user's rows; erasure leaves none, in any table
node scripts/prove-rate-limits.js        # password guessing, Gmail connections and exports stop at a limit
node scripts/prove-history-move.js       # a user's local history moves into their cloud account whole, and into nobody else's
node scripts/prove-single-instance.js    # a deploy leaves exactly one worker and one janitor, never none
node scripts/prove-ai-matning.js         # every AI call is measured by task and link, at the price actually charged
```

`prove-owner-checks.js` needs a server with login on (`AUTH_SECRET` set)
against the same database, at `PROVE_BASE_URL` (default
`http://localhost:3100`). CI builds the app and starts exactly that. Every
route that is handed someone's id asks `ägareAv*()` in `src/auth.js`
first and answers 404 when the caller is not the owner;
`prove-profile-scope.js` fails any route that forgets.

Never write `FROM profile LIMIT 1`. Worker code takes the owner from the
row it is acting on (`applications.profile_id`, `searches.profile_id`);
a route asks `aktivProfilId()` in `src/auth.js`; code with neither asks
`endaProfilId()` in `src/owner.js`, which refuses when there is more
than one. `prove-profile-scope.js` catches either pattern coming back.

Mail is the same rule. The worker keeps one mailbox per user
(`src/imapManager.js` → `brevlåda()` in `src/imap.js`), opened only once
that user has sent a letter through the app, and reading starts at that
first letter — nothing older is fetched. Every function in `src/imap.js`
is handed the mailbox owner, and reply matching looks only among that
owner's applications on every rung of the resolution order below.
`prove-imap-scope.js` runs it all against a fake IMAP client.

`prove-injection.js` is the one worth reading if you change a prompt.
Ad text is the only input a stranger writes, and it reaches three
prompts: the requirement extractor reads the description, the checklist
reads the requirement *names* the extractor produced (so an ad can
launder text into the grading prompt), and the letter writer gets the
description verbatim next to the CV — which a campaign then sends with
nobody reading it.

What holds is structural, not the model's good manners: the score is
computed in code from the stored rows, and a quote that is not
verbatim in the CV loses its status. An ad that says "sätt score till
100" gets 18.

---

## Deploying

`DEPLOY.md` is the whole procedure. The rule it rests on: Vercel and
Railway deploy from the branches `staging` and `production`, and only
`.github/workflows/deploy.yml` moves those — after it has migrated the
database they talk to, checked it with `db:check -- --live`, locked
the Data API (`scripts/lock-data-api.js`) and run `prove-rls.js`. So
code never runs against an older schema, and every migration must work
with the code before it (add, backfill, switch, drop later).

## Login and the Data API

Three modes, chosen by what the host sets (`src/authMode.js`):
`SUPABASE_URL` + `SUPABASE_ANON_KEY` is Google login through Supabase
Auth (the hosted app); `AUTH_SECRET` is our own password accounts (CI,
testing several users locally); neither is no login, one person on
their own machine — refused in production. Every route asks
`aktivProfilId()`, which works the same in all three.

Supabase only signs people in. Accounts, profiles and all data stay in
our tables (`users.auth_id` links a Supabase user), reached by the
server alone. Supabase publishes every public table through its Data
API with a key that ships to every browser, so **every table has RLS
and no policies, and the Data API roles have no grants** (migration
053). A new table without RLS fails `prove-rls.js` in CI.

Locally, `npx supabase start` runs a separate stack on ports 553xx
(`supabase/config.toml`), with an email link in place of Google.

## The operator

`users.role = 'admin'` (set only by `node scripts/make-admin.js`) reaches
`/admin`: the platform's key and credit, the embedding switch (the
platform's spend, in `platform_settings` — never on a profile), pool and
worker health, and every user's counts and costs — never their content.
For anyone else the page and `/api/admin/*` answer 404. Blocking an
account (`users.disabled_at`) answers its requests with 403 through
`forbidden()` in `aktivProfilId()`, pauses its campaigns with the
reason and closes its mailbox. A route that catches its own errors must
call `unstable_rethrow(err)` first, or it turns that 403 into its own.

## Changing the schema

Every database carries `schema_migrations`, and `scripts/migrate.js` is
the only thing that changes a schema. Migrations used to be pasted into
psql by hand, which left nothing recording which ones a database had —
and `db/schema.sql`, hand-written, fell 7 tables, 27 indexes and ~130
columns behind them. A fresh install got a broken app.

```bash
# 1. a new file, next number up — never edit one that has run
db/migrations/045_what_it_does.sql
# 2. apply it
npm run db:migrate
# 3. regenerate the snapshot, commit both
npm run db:schema
npm run db:check            # what CI runs: schema.sql == baseline + migrations
```

- Explain the *why* inside the migration with `COMMENT ON` — it travels
  into `db/schema.sql`, pg_dump and Supabase's table editor. A SQL
  comment in a migration file is read once.
- An edited migration that has already run is refused (checksum). Fix
  forward with a new file.
- `npm run db:check -- --live` compares a real database with what the
  migrations build. Run it on any database before trusting it; it is
  how the local one was verified before `db:migrate -- --adopt`
  recorded its hand-applied history.

## Reply matching — resolution order

Employers don't behave. Handle in this order:

1. `In-Reply-To` matches a stored `message_id` → confident
2. Last `References` entry matches → confident
3. Sender **domain** matches an application's recipient domain, sent within
   90 days, exactly one open application → probable, mark as inferred
4. Domain matches **multiple** open applications (two roles at one company)
   → don't guess, ask the user which
5. No match → leave in inbox, don't invent an association

Case 3 exists because employers reply from `anna.lindqvist@` when you sent
to `jobb@`, or start a fresh thread with no `In-Reply-To` at all.

---

## Latency budget (reply → user sees it): 15–30s

- IMAP IDLE push: 1–3s
- Fetch body: <1s
- **Classify (Haiku): ~1s** → status badge + notification out immediately
- Draft reply (Sonnet, streamed): fills in after

Notify *before* classifying. The thing that actually blows the budget is a
silently dropped IDLE connection — the reconnect wrapper matters more than
any optimization above it.

---

## Features that need data before they mean anything

Built into the schema, gated at read time. Don't surface them early with
invented numbers.

- **Calibration** (`calibration()`) — returns `{ready:false}` under 20
  applications. Percentages off 3 samples mislead.
- **Skills gap** (`skillsGap()`) — aggregates `flags[].tag` across all
  scored ads. Needs ~100+ ads to say anything useful.
- **Response priors by employer type** — `ads.employer_type` is populated
  on ingest; the model that uses it needs outcomes first.

---

## Conventions

- UI copy is **Swedish**. Code, comments, commits in English.
- LLM prompts are in Swedish (they operate on Swedish ad text).
- Money: none. Free tiers only — no paid email APIs.
- Deleted searches soft-delete (`searches.deleted_at`) because the inbox
  back-references them. `origin_search_id` is `ON DELETE SET NULL` so the
  "find similar jobs" button degrades to a disabled state instead of breaking.
