import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { DEFAULT_AI_ADAPTER, normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';

const root = process.cwd();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const startedAt = new Date().toISOString();
const logDir = path.join(root, 'logs', 'daily');
const logPath = path.join(logDir, `${runDate}-android.log`);
const latestLogPath = path.join(logDir, 'android-latest.log');
const statusPath = path.join(logDir, 'android-latest-status.json');

const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);
const rewriteScriptMap = {
  template: 'rewrite:android',
  claude: 'rewrite:android:claude',
  cursor: 'rewrite:android:cursor',
};
const rewriteScript = rewriteScriptMap[rewriteAdapter] || rewriteScriptMap[DEFAULT_AI_ADAPTER];

const steps = [
  ['collect', ['npm', ['run', 'collect:android']]],
  ['draft', ['npm', ['run', 'draft:android']]],
  ['rewrite', ['npm', ['run', rewriteScript]]],
  ...(shouldPublish ? [['publish', ['npm', ['run', 'publish:android']]]] : []),
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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
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
    `# Android daily pipeline ${status.runDate}`,
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
    topic: 'android',
    runDate,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: results.every((result) => result.ok) && results.length === steps.length,
    steps: results,
    publishEnabled: shouldPublish,
  };
  await writeFile(logPath, renderLog(status));
  await writeFile(latestLogPath, renderLog(status));
  await writeFile(statusPath, JSON.stringify(status, null, 2));
  console.log(`Android daily pipeline ${status.ok ? 'succeeded' : 'failed'}; log: ${path.relative(root, logPath)}`);
  if (!status.ok) process.exit(1);
}

main().catch(async (error) => {
  await mkdir(logDir, { recursive: true });
  await writeFile(statusPath, JSON.stringify({ topic: 'android', runDate, startedAt, finishedAt: new Date().toISOString(), ok: false, error: error.stack || error.message, steps: [] }, null, 2));
  console.error(error);
  process.exit(1);
});
