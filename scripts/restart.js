import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (f) => join(os.tmpdir(), f);
// identifies our worker in a process list that otherwise shows only
// "node worker.js" — see the kill filter below
const WORKER_TAG = '--jobbflo-worker';

// Windows keeps handles to .next open briefly after the kill — retry
async function rmRetry(path, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

// `npm run worker` execs plain `node worker.js` — that command line
// contains no path, so requiring 'jobbjakt' never matched the worker
// and every restart quietly stacked another one on top of the last.
// Four ended up racing for the same scoring queue and the same LLM.
// The worker is now launched with a marker argument that IS greppable,
// and matched on that instead.
const ps = [
  `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |`,
  `Where-Object { $_.ProcessId -ne $PID -and (`,
  `($_.CommandLine -match 'jobbjakt' -and $_.CommandLine -match 'node_modules[\\\\/]next')`,
  `-or $_.CommandLine -match '${WORKER_TAG}'`,
  `-or ($_.CommandLine -match 'worker\\.js' -and $_.CommandLine -notmatch 'node_modules') ) } |`,
  `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
].join(' ');

const kill = spawn('pwsh', ['-NoProfile', '-Command', ps], { shell: false });
kill.on('exit', async (code) => {
  console.log(`Stopped old processes (exit ${code}).`);
  // a previous `next build` leaves a production `.next` that breaks `next dev`
  // with ENOENT on .next/server/app/page.js — clear it so dev rebuilds fresh
  await rmRetry(join(root, '.next'));
  start('dev', 'jobbflo-dev.out.log', 'jobbflo-dev.err.log');
  start(`worker -- ${WORKER_TAG}`, 'jobbflo-worker.out.log', 'jobbflo-worker.err.log');
  console.log(`UI:     npm run dev     -> http://localhost:3000  (log: ${log('jobbflo-dev.out.log')})`);
  console.log(`Worker: npm run worker  (log: ${log('jobbflo-worker.out.log')})`);
});

function start(script, outFile, errFile) {
  const ps = [
    '-NoProfile', '-Command',
    `Start-Process npm.cmd -ArgumentList 'run ${script}' -WorkingDirectory '${root}' ` +
    `-RedirectStandardOutput '${log(outFile)}' -RedirectStandardError '${log(errFile)}' -WindowStyle Hidden`,
  ];
  spawn('pwsh', ps, { shell: false, stdio: 'ignore' });
}
