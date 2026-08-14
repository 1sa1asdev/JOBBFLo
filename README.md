# Jobbflo

AI-assisted job search + application CRM for the Swedish market. Polls
Arbetsförmedlingen's JobStream API into one shared ad pool, scores ads in two
layers against your CV and stated criteria, drafts cover letters you revise in
a chat loop, sends them via your own Gmail **only after explicit confirmation**,
and tracks replies via IMAP IDLE.

Architecture, invariants, and design decisions: see [CLAUDE.md](CLAUDE.md).

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, ANTHROPIC_API_KEY, GMAIL_*
```

Local Postgres (or use a free Neon/Supabase connection string):

```bash
docker run -d --name jobbjakt-pg -e POSTGRES_USER=jobbjakt -e POSTGRES_PASSWORD=jobbjakt -e POSTGRES_DB=jobbjakt -p 5433:5432 postgres:16-alpine
```

(Then set `DATABASE_URL=postgres://jobbjakt:jobbjakt@localhost:5433/jobbjakt`.)

**Edit `db/seed.sql` with your real CV first** — scoring quality depends
entirely on it. Then:

```bash
npm run db:init    # schema (db/schema.sql — read it first)
npm run db:seed    # profile + projects
```

## Build order (each step verifiable before the next)

1. **Prove the scoring** — `npm run try` fetches and scores 15 real ads.
   *Read the output.* If scores are wrong, iterate on the prompt in
   `src/score.js` — everything else is a wrapper around that call.
2. **Send one real application** — from the UI (below), to yourself first.
3. **Close the loop** — start the worker; reply to your own test mail and
   watch it get classified.
4. **UI** — `npm run dev` → http://localhost:3000

Optional: `npm run db:demo` loads fake demo data so the UI is explorable
without an API key or mailbox (dev only).

## Running

Two deployables — IMAP IDLE needs a long-lived process, so the worker
**cannot** run on Vercel:

| Process | Command | Hosts |
|---|---|---|
| UI + API | `npm run dev` / `npm run build && npm start` | Vercel (or Railway) |
| Worker | `npm run worker` | Railway / Fly / Render |
| Both (local) | `npm run restart` | — |

`npm run restart` kills any running dev/worker processes for this repo and
starts both again detached, logging to `%TEMP%\jobbflo-dev.log` and
`%TEMP%\jobbflo-worker.log` (Windows only).

The worker runs the JobStream poll (one global cursor in `poll_state`), the
scoring queue (per-search `scan_interval`), the IMAP IDLE loop with
reconnect + catch-up, and the follow-up checker (drafts only — nothing sends
without your click).

## Gmail

Use an [app password](https://myaccount.google.com/apppasswords), not your
real password. Searches can use plus-aliases (`din+frontend@gmail.com`) so
replies trace back to the search that sent them.

## JobStream

The `/stream` endpoint may require a free API key from
[jobtechdev.se](https://jobtechdev.se) (`JOBSTREAM_API_KEY`). The JobSearch
backfill used when creating a new search works without one.
