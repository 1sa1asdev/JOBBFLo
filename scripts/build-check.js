// Compile-check the app WITHOUT touching .next, which `next dev` serves
// from. next.config.mjs redirects distDir when JOBBFLO_BUILD_CHECK is set.
import { spawn } from 'node:child_process';

const child = spawn('npx', ['next', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, JOBBFLO_BUILD_CHECK: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));
