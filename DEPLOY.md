# Göra Jobbflo live

Three pieces (free tiers throughout). Postgres is the only thing they share.

```
Neon (Postgres)  ←──  Vercel (UI + API)      ← you, from anywhere
                 ←──  Railway (worker)        (IMAP IDLE — needs a
                                               long-lived process,
                                               can NOT run on Vercel)
```

## 0. One-time prerequisites

- Accounts: [neon.tech](https://neon.tech), [vercel.com](https://vercel.com),
  [railway.com](https://railway.com) (GitHub login works for all three).
- CLIs are already installed on this machine (`vercel`, `railway`).

## 1. Database — Neon

1. Create a project on neon.tech → copy the **connection string**
   (`postgres://...@...neon.tech/neondb?sslmode=require`).
2. Point your local `.env` `DATABASE_URL` at it, then load the schema + your profile:

```bash
npm run db:init
npm run db:seed
```

(Skip `db:demo` — that's local-dev fake data.)

## 2. UI + API — Vercel

```bash
vercel login
vercel link      # create a new project when asked
```

Set the environment variables (repeat for each, or paste them in the Vercel
dashboard under Project → Settings → Environment Variables):

```bash
vercel env add DATABASE_URL
vercel env add ANTHROPIC_API_KEY
vercel env add GMAIL_USER
vercel env add GMAIL_APP_PASSWORD
vercel env add APP_PASSWORD
```

`APP_PASSWORD` is **required** — it puts the whole site behind a password
(middleware.js). Without it, anyone who finds the URL can read your
applications and send mail from your Gmail.

Deploy:

```bash
vercel --prod
```

## 3. Worker — Railway

```bash
railway login
railway init     # new project
railway up       # deploys this directory; railway.json sets `npm run worker`
```

Then in the Railway dashboard, add the same variables to the service:
`DATABASE_URL`, `ANTHROPIC_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`
(+ `JOBSTREAM_API_KEY` if you have one). `APP_PASSWORD` is not needed here —
the worker has no inbound surface.

## 4. Verify the loop

1. Open the Vercel URL from your phone → browser asks for the password.
2. Send a test application to yourself from the letter view.
3. Reply to it from another mail account.
4. Within ~30s the Railway worker should classify it and the thread should
   appear in Inkorgen with a suggested reply.

## Alternative: everything on Railway

If you'd rather run one platform: create **two services** from the same repo
in one Railway project (plus a Railway Postgres). Service A (web): override
start command to `npm run build && npm run start`. Service B (worker): uses
railway.json as-is. Then Vercel and Neon are not needed.
