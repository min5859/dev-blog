import { spawn } from 'node:child_process';

const root = process.cwd();

// 전 토픽 weekly-rollup. PUBLISH_WEEKLY/NEWSLETTER_DATE 등은 env 상속으로 전파.
const STANDARD = ['linux', 'opensource', 'android', 'ai-coding-agents', 'opensource-curation'];
const LENSES = ['linux-kernel-security', 'linux-toolchain', 'linux-distro-stable', 'linux-perf-rt', 'linux-arch-platform', 'linux-gpu-ai'];
const topics = [...STANDARD, ...LENSES];

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn('node', args, { cwd: root, stdio: 'inherit', env: process.env });
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  let failed = 0;
  for (const topic of topics) {
    const code = await runNode(['scripts/weekly-rollup.mjs', topic]);
    if (code !== 0) {
      console.error(`run-weekly-all: ${topic} failed (exit ${code}); continuing`);
      failed += 1;
    }
  }
  console.log(`run-weekly-all: ${topics.length - failed}/${topics.length} topic(s) ok`);
  // best-effort: 일부 토픽 실패해도 나머지는 진행. 전부 실패 시에만 non-zero.
  if (failed === topics.length) process.exit(1);
}

main();
