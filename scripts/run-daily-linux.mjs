import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';

const root = process.cwd();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const startedAt = new Date().toISOString();
const logDir = path.join(root, 'logs', 'daily');
const logPath = path.join(logDir, `${runDate}-linux.log`);
const latestLogPath = path.join(logDir, 'linux-latest.log');
const statusPath = path.join(logDir, 'linux-latest-status.json');

const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);
const rewriteScriptMap = {
  template: 'rewrite:linux',
  claude: 'rewrite:linux:claude',
  cursor: 'rewrite:linux:cursor',
};
const rewriteScript = rewriteScriptMap[rewriteAdapter] || 'rewrite:linux:cursor';

const steps = [
  ['collect', ['npm', ['run', 'collect:linux']]],
  ['draft', ['npm', ['run', 'draft:linux']]],
  ['rewrite', ['npm', ['run', rewriteScript]]],
  ...(shouldPublish ? [['publish', ['npm', ['run', 'publish:linux']]]] : []),
  ['build', ['npm', ['run', 'build']]],
];

function runStep(name, command, args) {
  const stepStartedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, NEWSLETTER_DATE: runDate },
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
    `# Linux daily pipeline ${status.runDate}`,
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

  const results = [];
  for (const [name, [command, args]] of steps) {
    const result = await runStep(name, command, args);
    results.push(result);
    if (!result.ok) break;
  }

  const status = {
    topic: 'linux',
    runDate,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: results.every((result) => result.ok) && results.length === steps.length,
    steps: results,
    publishEnabled: shouldPublish,
    outputs: {
      generatedDraft: `data/generated/linux/${runDate}-linux-daily-briefing.json`,
      generatedRewrite: `data/generated/linux/rewritten-${runDate}-linux-daily-briefing.json`,
      post: shouldPublish ? `content/topics/linux/posts/${runDate}-linux-daily-briefing.json` : null,
      site: 'public/index.html',
      log: path.relative(root, logPath),
    },
  };

  await writeFile(logPath, renderLog(status));
  await writeFile(latestLogPath, renderLog(status));
  await writeFile(statusPath, JSON.stringify(status, null, 2));

  console.log(`Linux daily pipeline ${status.ok ? 'succeeded' : 'failed'}; log: ${path.relative(root, logPath)}`);
  if (!status.ok) process.exit(1);
}

main().catch(async (error) => {
  await mkdir(logDir, { recursive: true });
  const status = {
    topic: 'linux',
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
