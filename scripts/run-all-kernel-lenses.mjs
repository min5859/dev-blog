import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const topics = [
  'linux-kernel-security',
  'linux-toolchain',
  'linux-distro-stable',
  'linux-perf-rt',
  'linux-arch-platform',
  'linux-gpu-ai',
];

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn('node', args, { cwd: root, stdio: 'inherit' });
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  for (const topic of topics) {
    const code = await runNode(['scripts/run-daily-lore-lens.mjs', topic]);
    if (code !== 0) {
      console.error(`run-all-kernel-lenses: stopped on ${topic} (exit ${code})`);
      process.exit(code ?? 1);
    }
  }
  console.log('run-all-kernel-lenses: all topics succeeded');
}

main();
