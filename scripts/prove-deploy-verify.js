// Proves the deploy workflow only goes green when the release runs.
//
//   node scripts/prove-deploy-verify.js
//
// What happened on 21 Oct: Railway was down when `production` moved, the
// workflow went green, and the worker and janitor ran the old code for
// hours. scripts/verify-deploy.js is run here against a fake Vercel
// (/api/health, a deploy hook), a fake Railway API and a throwaway
// database holding the heartbeats:
//
//   1. app, worker and janitor on the new commit → green
//   2. any of them on the old one, or code from before versions → red,
//      naming which, after the time limit
//   3. a worker on the new commit that has stopped beating (crashed
//      after starting) → red
//   4. a host that missed the push is nudged once — Vercel's hook, and
//      Railway's API for exactly the services behind — and when they
//      come up the run goes green
//   5. an app behind Vercel's login is read with the bypass secret
import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { anslutning } from '../src/dbConfig.js';

const NY = 'a'.repeat(40);
const GAMMAL = 'b'.repeat(40);
const BAS = process.env.DATABASE_URL || 'postgres://jobbjakt:jobbjakt@localhost:5432/jobbjakt';
const DB = `jobbflo_bevis_deploy_${process.pid}`;
const medDb = (db) => { const u = new URL(BAS); u.pathname = `/${db}`; return u.toString(); };

let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(62)}${info ? ` ${info}` : ''}`);
};

const admin = new pg.Client(anslutning(BAS));
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
const db = new pg.Client(anslutning(medDb(DB)));
await db.connect();
await db.query(`CREATE TABLE poll_state (key text PRIMARY KEY, cursor_ts timestamptz, last_run_at timestamptz, note text)`);

async function hjärta(nyckel, note, sekunderSedan = 0) {
  await db.query(
    `INSERT INTO poll_state (key, last_run_at, note) VALUES ($1, now() - make_interval(secs => $3), $2)
     ON CONFLICT (key) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, note = EXCLUDED.note`,
    [nyckel, note, sekunderSedan]);
}

// ---- the fake hosts ----
const läge = { version: GAMMAL, skydd: null, krokar: 0, railway: [] };
const TJÄNSTER = [{ id: 'svc-w', name: 'worker' }, { id: 'svc-j', name: 'janitor' }];
const server = http.createServer((req, res) => {
  let kropp = '';
  req.on('data', (d) => { kropp += d; });
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') {
      if (läge.skydd && req.headers['x-vercel-protection-bypass'] !== läge.skydd) {
        res.setHeader('content-type', 'text/html');
        res.statusCode = 401;
        return res.end('<html>Logga in på Vercel</html>');
      }
      return res.end(JSON.stringify({ ok: true, ...(läge.version ? { version: läge.version } : {}) }));
    }
    if (req.url === '/krok' && req.method === 'POST') {
      läge.krokar += 1;
      läge.version = NY; // the build Vercel missed
      return res.end('{}');
    }
    if (req.url === '/graphql') {
      const { query, variables } = JSON.parse(kropp);
      if (req.headers['project-access-token'] !== 'bevis-token') {
        return res.end(JSON.stringify({ errors: [{ message: 'Not Authorized' }] }));
      }
      if (query.includes('projectToken')) {
        return res.end(JSON.stringify({ data: { projectToken: { projectId: 'p1', environmentId: 'e1' } } }));
      }
      if (query.includes('project(')) {
        return res.end(JSON.stringify({ data: { project: { services: { edges: TJÄNSTER.map((node) => ({ node })) } } } }));
      }
      if (query.includes('environmentTriggersDeploy')) {
        läge.railway.push(variables.input);
        // the new container takes over and beats with the new commit
        const nyckel = variables.input.serviceId === 'svc-w' ? 'imap_worker_alive' : 'janitor_alive';
        await hjärta(nyckel, NY);
        return res.end(JSON.stringify({ data: { environmentTriggersDeploy: true } }));
      }
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const URL_ = `http://127.0.0.1:${server.address().port}`;

function kör(extra = {}) {
  return new Promise((klar) => {
    const barn = spawn(process.execPath, ['scripts/verify-deploy.js', NY], {
      env: {
        ...process.env,
        DATABASE_URL: medDb(DB),
        APP_URL: URL_,
        VERIFY_WORKER: 'true',
        VERIFY_TIMEOUT_S: '3',
        VERIFY_NUDGE_S: '1',
        VERIFY_INTERVAL_S: '0.2',
        RAILWAY_API: `${URL_}/graphql`,
        VERCEL_DEPLOY_HOOK: '',
        RAILWAY_TOKEN: '',
        VERCEL_BYPASS: '',
        ...extra,
      },
    });
    let ut = '';
    barn.stdout.on('data', (d) => { ut += d; });
    barn.stderr.on('data', (d) => { ut += d; });
    barn.on('close', (kod) => klar({ kod, ut }));
  });
}

try {
  // ---- 1 ----
  läge.version = NY;
  await hjärta('imap_worker_alive', NY);
  await hjärta('janitor_alive', NY);
  let r = await kör();
  kolla('1. allt kör den nya commiten → grönt', r.kod === 0, r.kod ? r.ut.slice(-300) : '');

  // ---- 2 ----
  läge.version = GAMMAL;
  await hjärta('imap_worker_alive', GAMMAL);
  await hjärta('janitor_alive', null); // a janitor from before it wrote versions
  r = await kör();
  kolla('2. gammal app, worker och janitor → rött', r.kod === 1);
  kolla('2. och det säger vilka',
    ['::error::app', '::error::worker', '::error::janitor'].every((s) => r.ut.includes(s)));
  kolla('2. en janitor utan version sägs vara från före kontrollen', /janitor.*före den här kontrollen/.test(r.ut));

  läge.version = undefined; // an app from before /api/health said its version
  await hjärta('imap_worker_alive', NY);
  await hjärta('janitor_alive', NY);
  r = await kör();
  kolla('2. en app utan version → rött', r.kod === 1 && r.ut.includes('::error::app') && !r.ut.includes('::error::worker'));

  // ---- 3 ----
  läge.version = NY;
  await hjärta('imap_worker_alive', NY, 600);
  r = await kör();
  kolla('3. en worker på rätt commit som slutat slå → rött', r.kod === 1 && r.ut.includes('::error::worker'));

  // ---- 4 ----
  läge.version = GAMMAL;
  await hjärta('imap_worker_alive', GAMMAL);
  await hjärta('janitor_alive', GAMMAL);
  r = await kör({ VERCEL_DEPLOY_HOOK: `${URL_}/krok`, RAILWAY_TOKEN: 'bevis-token', VERIFY_TIMEOUT_S: '6' });
  kolla('4. Vercel puffas en gång', läge.krokar === 1, `${läge.krokar}`);
  kolla('4. Railway puffas för båda tjänsterna, i rätt projekt och miljö',
    läge.railway.length === 2
    && läge.railway.every((i) => i.projectId === 'p1' && i.environmentId === 'e1')
    && läge.railway.map((i) => i.serviceId).sort().join() === 'svc-j,svc-w');
  kolla('4. när de kommit upp → grönt', r.kod === 0, r.kod ? r.ut.slice(-300) : '');

  // only what is behind gets nudged
  läge.krokar = 0; läge.railway = [];
  läge.version = NY;
  await hjärta('imap_worker_alive', NY);
  await hjärta('janitor_alive', GAMMAL);
  r = await kör({ VERCEL_DEPLOY_HOOK: `${URL_}/krok`, RAILWAY_TOKEN: 'bevis-token', VERIFY_TIMEOUT_S: '6' });
  kolla('4. bara det som släpar puffas',
    r.kod === 0 && läge.krokar === 0 && läge.railway.length === 1 && läge.railway[0].serviceId === 'svc-j');

  // ---- 5 ----
  läge.skydd = 'hemligt';
  r = await kör();
  kolla('5. bakom Vercels inloggning utan nyckel → rött, med tips', r.kod === 1 && r.ut.includes('VERCEL_BYPASS'));
  r = await kör({ VERCEL_BYPASS: 'hemligt' });
  kolla('5. med nyckeln läses versionen → grönt', r.kod === 0, r.kod ? r.ut.slice(-300) : '');
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  server.close();
  await db.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await admin.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
