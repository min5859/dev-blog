import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';

const root = process.cwd();
const topic = process.argv[2] || process.env.TOPIC;
if (!topic) {
  console.error('Usage: node scripts/run-daily-lore-lens.mjs <topicId>');
  process.exit(1);
}

const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const startedAt = new Date().toISOString();
const logDir = path.join(root, 'logs', 'daily');
const logPath = path.join(logDir, `${runDate}-${topic}.log`);
const latestLogPath = path.join(logDir, `${topic}-latest.log`);
const statusPath = path.join(logDir, `${topic}-latest-status.json`);

const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);

function runStep(name, command, args, extraEnv = {}) {
  const stepStartedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv, NEWSLETTER_DATE: runDate },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({
        name,
        command: [command, ...args].join(' '),
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
        code,
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    child.on('error', (error) => {
      resolve({
        name,
        command: [command, ...args].join(' '),
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
        code: null,
        ok: false,
        stdout: stdout.trim(),
        stderr: `${stderr}\n${error.stack || error.message}`.trim(),
      });
    });
  });
}

function renderLog(status) {
  const lines = [
    `# Lens daily pipeline ${status.topic} ${status.runDate}`,
    `startedAt: ${status.startedAt}`,
    `finishedAt: ${status.finishedAt}`,
    `ok: ${status.ok}`,
    '',
  ];

  for (const step of status.steps) {
    lines.push(`## ${step.name}`);
    lines.push(`command: ${step.command}`);
    lines.push(`startedAt: ${step.startedAt}`);
    lines.push(`finishedAt: ${step.finishedAt}`);
    lines.push(`code: ${step.code}`);
    lines.push('');
    if (step.stdout) {
      lines.push('stdout:');
      lines.push('```');
      lines.push(step.stdout);
      lines.push('```');
    }
    if (step.stderr) {
      lines.push('stderr:');
      lines.push('```');
      lines.push(step.stderr);
      lines.push('```');
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  await mkdir(logDir, { recursive: true });

  const rewriteEnv = rewriteAdapter === 'template'
    ? { AI_ADAPTER: 'template' }
    : rewriteAdapter === 'claude'
      ? { AI_ADAPTER: 'claude' }
      : { AI_ADAPTER: 'cursor' };

  const steps = [
    ['collect', 'node', ['scripts/collect-lore-lens.mjs', topic], {}],
    ['draft', 'node', ['scripts/draft-lore-lens.mjs', topic], {}],
    ['rewrite', 'node', ['scripts/ai-rewrite-lore-lens.mjs', topic], rewriteEnv],
    ...(shouldPublish ? [['publish', 'node', ['scripts/publish-lore-lens.mjs', topic], {}]] : []),
    ['build', 'npm', ['run', 'build'], {}],
  ];

  const results = [];
  for (const [name, command, args, extraEnv] of steps) {
    const result = await runStep(name, command, args, extraEnv);
    results.push(result);
    if (!result.ok) break;
  }

  const status = {
    topic,
    runDate,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: results.every((result) => result.ok) && results.length === steps.length,
    steps: results,
    publishEnabled: shouldPublish,
    outputs: {
      site: 'public/index.html',
      log: path.relative(root, logPath),
    },
  };

  await writeFile(logPath, renderLog(status));
  await writeFile(latestLogPath, renderLog(status));
  await writeFile(statusPath, JSON.stringify(status, null, 2));

  console.log(`[${topic}] daily pipeline ${status.ok ? 'succeeded' : 'failed'}; log: ${path.relative(root, logPath)}`);
  if (!status.ok) process.exit(1);
}

main().catch(async (error) => {
  await mkdir(logDir, { recursive: true });
  const status = {
    topic,
    runDate,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: false,
    error: error.stack || error.message,
    steps: [],
  };
  await writeFile(statusPath, JSON.stringify(status, null, 2));
  console.error(error);
  process.exit(1);
});
