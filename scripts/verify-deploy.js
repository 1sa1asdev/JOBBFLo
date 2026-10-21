// ------------------------------------------------------------
// Is the release actually running? The deploy workflow's last step.
//
//   node scripts/verify-deploy.js <commit>
//
// Moving the `production` branch only asks Vercel and Railway to build.
// On 21 Oct Railway was down when the branch moved: the workflow went
// green, the app ran the new code and the worker and janitor kept
// running the old for hours, with nothing saying so. This waits until
// every part answers with the commit it was handed, and fails if one
// does not:
//
//   app      /api/health says version = <commit>          (APP_URL)
//   worker   poll_state imap_worker_alive: that commit,   (VERIFY_WORKER=true)
//            written in the last two minutes
//   janitor  poll_state janitor_alive: the same
//
// Only the instance holding the lock writes a heartbeat (src/ensam.js),
// so a fresh heartbeat with the new commit means the new container took
// over — not merely that it started.
//
// A host that missed the push gets one nudge after VERIFY_NUDGE_S:
// Vercel through its deploy hook (VERCEL_DEPLOY_HOOK), Railway through
// its API with a project token (RAILWAY_TOKEN; the services are found
// by name, RAILWAY_WORKER_SERVICE and RAILWAY_JANITOR_SERVICE, default
// "worker" and "janitor"). Both are optional; without them this only waits.
//
// Optional:
//   VERCEL_BYPASS       Vercel's "Protection Bypass for Automation" secret,
//                       if the deployment is behind Vercel's login
//   VERIFY_TIMEOUT_S    how long to wait in all (default 900)
//   VERIFY_NUDGE_S      when to nudge (default 300)
//   VERIFY_INTERVAL_S   between checks (default 15)
// ------------------------------------------------------------
import 'dotenv/config';
import pg from 'pg';
import { anslutning } from '../src/dbConfig.js';

const sha = (process.argv[2] || '').trim();
if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
  console.error('användning: node scripts/verify-deploy.js <commit>');
  process.exit(2);
}

const sek = (namn, standard) => Number(process.env[namn] || standard) * 1000;
const TIDSGRÄNS = sek('VERIFY_TIMEOUT_S', 900);
const PUFF_EFTER = sek('VERIFY_NUDGE_S', 300);
const VAR = sek('VERIFY_INTERVAL_S', 15);
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const KOLLA_WORKER = process.env.VERIFY_WORKER === 'true';
const RAILWAY_API = process.env.RAILWAY_API || 'https://backboard.railway.com/graphql/v2';
const TJÄNST = {
  worker: (process.env.RAILWAY_WORKER_SERVICE || 'worker').trim().toLowerCase(),
  janitor: (process.env.RAILWAY_JANITOR_SERVICE || 'janitor').trim().toLowerCase(),
};

// A short sha from a person, a full one from the workflow: either side
// may be the shorter.
const samma = (v) => !!v && (v.startsWith(sha) || sha.startsWith(v)) && v.length >= 7;

if (!APP_URL && !KOLLA_WORKER) {
  console.log('· varken APP_URL eller VERIFY_WORKER satt — inget att kontrollera');
  process.exit(0);
}

const db = KOLLA_WORKER ? new pg.Client(anslutning(process.env.DATABASE_URL)) : null;
if (db) await db.connect();

// Each check answers { klar, läge } — läge is what a person reads when
// it never gets there.
async function app() {
  const headers = process.env.VERCEL_BYPASS
    ? { 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS } : {};
  try {
    const svar = await fetch(`${APP_URL}/api/health`, { headers, signal: AbortSignal.timeout(10_000) });
    const text = await svar.text();
    let kropp = null;
    try { kropp = JSON.parse(text); } catch { /* an HTML page: Vercel's login, or an error */ }
    if (!kropp) return { klar: false, läge: `HTTP ${svar.status}, inte JSON (bakom Vercels inloggning? sätt VERCEL_BYPASS)` };
    if (!kropp.version) return { klar: false, läge: `HTTP ${svar.status}, ingen version — kör kod från före den här kontrollen` };
    return { klar: svar.ok && samma(kropp.version), läge: `kör ${kropp.version.slice(0, 7)} (HTTP ${svar.status})` };
  } catch (err) {
    return { klar: false, läge: `svarar inte: ${err.message}` };
  }
}

async function puls(nyckel) {
  const { rows: [r] } = await db.query(
    `SELECT note, extract(epoch FROM now() - last_run_at)::int AS sekunder
     FROM poll_state WHERE key = $1`, [nyckel]);
  if (!r) return { klar: false, läge: 'har aldrig hörts av' };
  const vilken = r.note ? r.note.slice(0, 7) : 'okänd version (kod från före den här kontrollen)';
  const färsk = r.sekunder != null && r.sekunder < 120;
  return { klar: färsk && samma(r.note), läge: `${vilken}, senast för ${r.sekunder} s sedan` };
}

const delar = {
  ...(APP_URL ? { app } : {}),
  ...(KOLLA_WORKER ? { worker: () => puls('imap_worker_alive'), janitor: () => puls('janitor_alive') } : {}),
};

// ---- the nudge ----
async function railway(query, variables = {}) {
  const svar = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Project-Access-Token': process.env.RAILWAY_TOKEN },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const kropp = await svar.json().catch(() => ({}));
  if (!svar.ok || kropp.errors?.length) {
    throw new Error(kropp.errors?.[0]?.message || `HTTP ${svar.status}`);
  }
  return kropp.data;
}

async function puffaRailway(vilka) {
  if (!process.env.RAILWAY_TOKEN) {
    console.log('· RAILWAY_TOKEN saknas — kan inte be Railway bygga, väntar bara');
    return;
  }
  try {
    const { projectToken: { projectId, environmentId } } = await railway(
      'query { projectToken { projectId environmentId } }');
    const { project } = await railway(
      'query ($id: String!) { project(id: $id) { services { edges { node { id name } } } } }', { id: projectId });
    const alla = project.services.edges.map((e) => e.node);
    for (const del of vilka) {
      const namn = TJÄNST[del];
      const tjänst = alla.find((t) => t.name.toLowerCase() === namn);
      if (!tjänst) {
        console.log(`· ingen Railway-tjänst heter "${namn}" — finns: ${alla.map((t) => t.name).join(', ')} (sätt RAILWAY_${del.toUpperCase()}_SERVICE)`);
        continue;
      }
      await railway(
        'mutation ($input: EnvironmentTriggersDeployInput!) { environmentTriggersDeploy(input: $input) }',
        { input: { projectId, environmentId, serviceId: tjänst.id } });
      console.log(`· bad Railway bygga ${tjänst.name}`);
    }
  } catch (err) {
    console.log(`· Railway svarade inte på puffen: ${err.message}`);
  }
}

async function puffaVercel() {
  if (!process.env.VERCEL_DEPLOY_HOOK) {
    console.log('· VERCEL_DEPLOY_HOOK saknas — kan inte be Vercel bygga, väntar bara');
    return;
  }
  try {
    const svar = await fetch(process.env.VERCEL_DEPLOY_HOOK, { method: 'POST', signal: AbortSignal.timeout(20_000) });
    console.log(svar.ok ? '· bad Vercel bygga' : `· Vercels deploy hook svarade HTTP ${svar.status}`);
  } catch (err) {
    console.log(`· Vercels deploy hook svarade inte: ${err.message}`);
  }
}

// ---- the wait ----
const start = Date.now();
const klara = new Set();
const senast = {};
let puffad = false;
try {
  for (;;) {
    for (const [namn, kolla] of Object.entries(delar)) {
      if (klara.has(namn)) continue;
      // a database that blinks is a "not yet", not a crash
      const { klar, läge } = await kolla().catch((err) => ({ klar: false, läge: `fel: ${err.message}` }));
      if (klar) {
        klara.add(namn);
        console.log(`✓ ${namn.padEnd(8)} ${läge}  (${Math.round((Date.now() - start) / 1000)} s)`);
      } else if (senast[namn] !== läge) {
        console.log(`… ${namn.padEnd(8)} ${läge}`);
      }
      senast[namn] = läge;
    }
    if (klara.size === Object.keys(delar).length) break;

    const gått = Date.now() - start;
    if (!puffad && gått >= PUFF_EFTER) {
      puffad = true;
      const väntar = Object.keys(delar).filter((n) => !klara.has(n));
      console.log(`· ${väntar.join(', ')} kör inte ${sha.slice(0, 7)} efter ${Math.round(gått / 1000)} s — puffar`);
      if (väntar.includes('app')) await puffaVercel();
      const påRailway = väntar.filter((n) => n !== 'app');
      if (påRailway.length) await puffaRailway(påRailway);
    }
    if (gått >= TIDSGRÄNS) break;
    await new Promise((ok) => setTimeout(ok, VAR));
  }
} finally {
  if (db) await db.end().catch(() => {});
}

const kvar = Object.keys(delar).filter((n) => !klara.has(n));
if (!kvar.length) {
  console.log(`\nallt kör ${sha.slice(0, 7)}`);
  process.exit(0);
}
for (const n of kvar) {
  console.log(`::error::${n} kör inte ${sha.slice(0, 7)} efter ${Math.round(TIDSGRÄNS / 1000)} s: ${senast[n]}`);
}
console.log(`
Grenen är flyttad och databasen migrerad, men releasen kör inte överallt.
${kvar.includes('app') ? '  app:      Vercel → Deployments: byggdes grenen? Misslyckades bygget?\n' : ''}\
${kvar.some((n) => n !== 'app') ? '  worker/janitor: Railway → tjänsten → Deployments. Står Railway still\n                  (status.railway.com), tryck Redeploy när de är uppe igen\n                  och kör det här arbetsflödet igen.\n' : ''}`);
process.exit(1);
