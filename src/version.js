// ------------------------------------------------------------
// Which commit this process runs, as the host says. Railway and Vercel
// both set it for builds from GitHub; anything else (a local run, a
// manual upload) is "lokal".
//
// The app shows it on /api/health and the worker and janitor write it
// with their heartbeats, so the deploy workflow can check that a release
// is actually running — not just that its branch moved
// (scripts/verify-deploy.js).
// ------------------------------------------------------------
export const version = () => (
  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'lokal'
).trim().slice(0, 40);
