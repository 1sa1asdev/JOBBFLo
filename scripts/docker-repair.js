// ------------------------------------------------------------
// Docker Desktop on this machine leaves behind Unix-socket files whose
// names Windows itself cannot parse. The next start tries to remove its
// own stale socket, fails, and the backend crashes:
//
//   initializing Inference manager: listening on unix://C:/.../run/
//   dockerInference: remove ...: The file cannot be accessed by the
//   system. (listener: The filename, directory name, or volume label
//   syntax is incorrect.)
//
// del, rmdir, robocopy and .NET's extended-length path API all refuse
// those files. WSL sees them as ordinary zero-byte files and removes
// them without complaint, which is the whole trick here.
//
// NEVER use Docker Desktop's "Reset to factory defaults" for this — it
// deletes every volume, including the Postgres data this app lives on.
// ------------------------------------------------------------
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const B = String.fromCharCode(92);   // literal backslash, written this way
                                     // so no shell or heredoc can eat it
const HOME = process.env.USERPROFILE || `C:${B}Users${B}isaia`;
const SOCKET_DIRS = [
  [HOME, 'AppData', 'Local', 'Docker', 'run'].join(B),
  [HOME, 'AppData', 'Local', 'docker-secrets-engine'].join(B),
];
const DESKTOP = ['C:', 'Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'].join(B);

const sh = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts }); }
  catch (e) { return e.stdout || ''; }
};
const wslPath = (win) => '/mnt/' + win[0].toLowerCase() + win.slice(2).split(B).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dockerUp = () => { try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; } };

console.log('1. stoppar Docker');
sh('powershell', ['-NoProfile', '-Command',
  "Get-Process -Name 'Docker Desktop','com.docker.backend','com.docker.build','docker-agent' " +
  '-ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue']);
await sleep(5000);

console.log('2. rensar spöksocketar via WSL');
for (const dir of SOCKET_DIRS) {
  if (!existsSync(dir)) { console.log(`   ${dir}: finns inte`); continue; }
  // Remove the DIRECTORY, not just its contents: the corruption is in
  // the directory entry, so deleting only the files lets Docker
  // recreate an equally broken one on the next start.
  sh('wsl', ['-e', 'rm', '-rf', wslPath(dir)]);
  console.log(`   ${dir}: ${existsSync(dir) ? 'KVAR — kör som administratör?' : 'borttagen'}`);
}

console.log('3. startar Docker Desktop');
spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${DESKTOP}'`], { detached: true, stdio: 'ignore' }).unref();

process.stdout.write('   väntar på daemon');
for (let i = 0; i < 36 && !dockerUp(); i++) { process.stdout.write('.'); await sleep(5000); }
console.log('');

if (!dockerUp()) {
  console.error('   Docker svarar inte. Öppna Docker Desktop och läs felet — klicka ALDRIG "Reset to factory defaults".');
  process.exit(1);
}
console.log('   Docker OK');

console.log('4. startar Postgres-containern');
sh('docker', ['start', 'jobbjakt-pg']);
await sleep(6000);
const ok = sh('docker', ['exec', 'jobbjakt-pg', 'psql', '-U', 'jobbjakt', '-A', '-t', '-c',
  "SELECT count(*)||' annonser, '||(SELECT count(*) FROM match_results WHERE shortlisted_at IS NOT NULL)||' favoriter' FROM ads WHERE removed_at IS NULL"]).trim();
console.log(`   ${ok || 'Postgres svarar inte än — vänta några sekunder och kör npm run restart'}`);
console.log('\nKlart. Kör: npm run restart');
