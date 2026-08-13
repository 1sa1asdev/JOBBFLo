# Jobbflo

AI-assisted job search + application CRM for the Swedish market.
Single user (the developer) for now; schema designed so multi-user is
additive, not a rewrite.

## What it does

1. **Finds jobs** — polls Arbetsförmedlingen's JobStream API. LinkedIn and
   Academic Work are paste-in only (no usable API, ToS forbids scraping).
2. **Scores them** in two layers — natural-language criteria become API
   filters (cheap narrowing), then the full ad text is cross-referenced
   against the user's CV and stated criteria (nuance the taxonomy can't
   express).
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

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20+, ESM | already written this way |
| Language | TypeScript | port `src/` as you go; it's plain JS today |
| Framework | Next.js (App Router) | one repo for UI + API routes |
| DB | Postgres — Neon or Supabase | free tier covers single-user comfortably |
| DB access | `pg` directly, or Drizzle | schema is hand-written SQL; Drizzle if you want types |
| Styling | Tailwind | mockup is hand-CSS; tokens map cleanly |
| LLM | `@anthropic-ai/sdk` | Sonnet for scoring/letters, Haiku for fast classify |
| Email out | `nodemailer` → Gmail SMTP | app password, no OAuth |
| Email in | `imapflow` → Gmail IMAP IDLE | push, 1–3s latency |
| UI host | Vercel | free, zero config for Next |
| Worker host | Railway / Fly / Render | **see below — this cannot be Vercel** |

### The one architectural constraint that matters

**IMAP IDLE needs a long-lived process. Serverless cannot do this.**

Vercel functions are request-scoped and time-limited; an IDLE connection
must stay open indefinitely. So the system is two deployables:

```
┌────────────────────┐         ┌──────────────────────┐
│  Next.js (Vercel)  │         │  Worker (Railway)    │
│  UI + API routes   │         │  long-running        │
│                    │         │                      │
│  - chat/criteria   │         │  - IMAP IDLE loop    │
│  - list, letter UI │◄───────►│  - JobStream cron    │
│  - inbox UI        │ Postgres│  - scoring queue     │
│  - send (on click) │         │  - followup checker  │
└────────────────────┘         └──────────────────────┘
```

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
  schema.sql         source of truth; read this first
  seed.sql           profile + projects — edit with real CV before running
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

**1. Prove the scoring** ← start here
```bash
npm run db:init && npm run db:seed && npm run try
```
Prints 15 scored ads. *Read them.* If scores are wrong, iterate on the
prompt in `src/score.js`. Everything else is a wrapper around this call —
if it's bad, nothing downstream matters.

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
