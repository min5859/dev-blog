import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { DEFAULT_AI_ADAPTER, normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';

const root = process.cwd();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const startedAt = new Date().toISOString();
const logDir = path.join(root, 'logs', 'daily');
const logPath = path.join(logDir, `${runDate}-opensource-curation.log`);
const latestLogPath = path.join(logDir, 'opensource-curation-latest.log');
const statusPath = path.join(logDir, 'opensource-curation-latest-status.json');

const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);
const rewriteScriptMap = {
  template: 'rewrite:opensource-curation',
  claude: 'rewrite:opensource-curation:claude',
  codex: 'rewrite:opensource-curation:codex',
  cursor: 'rewrite:opensource-curation:cursor',
};
const rewriteScript = rewriteScriptMap[rewriteAdapter] || rewriteScriptMap[DEFAULT_AI_ADAPTER];

const skipUpstream = process.env.OPENSOURCE_CURATION_SKIP_UPSTREAM === '1';
const upstreamSteps = skipUpstream
  ? []
  : [
      ['discover', ['node', [path.join(root, 'scripts', 'opensource-curation', 'discover.mjs')]]],
      ['fetch', ['node', [path.join(root, 'scripts', 'opensource-curation', 'fetch.mjs')]]],
      ['analyze', ['node', [path.join(root, 'scripts', 'opensource-curation', 'analyze.mjs')]]],
    ];

const steps = [
  ...upstreamSteps,
  ['collect', ['npm', ['run', 'collect:opensource-curation']]],
  ['draft', ['npm', ['run', 'draft:opensource-curation']]],
  ['rewrite', ['npm', ['run', rewriteScript]]],
  ...(shouldPublish ? [['publish', ['npm', ['run', 'publish:opensource-curation']]]] : []),
  ['build', ['npm', ['run', 'build']]],
];

function runStep(name, command, args) {
  const stepStartedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, NEWSLETTER_DATE: runDate }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (code) =>
      resolve({
        name,
        command: [command, ...args].join(' '),
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
        code,
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      }),
    );
    child.on('error', (e) =>
      resolve({
        name,
        command: [command, ...args].join(' '),
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
        code: null,
        ok: false,
        stdout: stdout.trim(),
        stderr: `${stderr}\n${e.stack || e.message}`.trim(),
      }),
    );
  });
}

function renderLog(status) {
  const lines = [`# Opensource curation pipeline ${status.runDate}`, `startedAt: ${status.startedAt}`, `finishedAt: ${status.finishedAt}`, `ok: ${status.ok}`, ''];
  for (const step of status.steps) {
    lines.push(`## ${step.name}`, `command: ${step.command}`, `startedAt: ${step.startedAt}`, `finishedAt: ${step.finishedAt}`, `code: ${step.code}`, '');
    if (step.stdout) lines.push('stdout:', '```', step.stdout, '```');
    if (step.stderr) lines.push('stderr:', '```', step.stderr, '```');
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
    topic: 'opensource-curation',
    runDate,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: results.every((r) => r.ok) && results.length === steps.length,
    steps: results,
    publishEnabled: shouldPublish,
  };
  await writeFile(logPath, renderLog(status));
  await writeFile(latestLogPath, renderLog(status));
  await writeFile(statusPath, JSON.stringify(status, null, 2));
  console.log(`Opensource curation pipeline ${status.ok ? 'succeeded' : 'failed'}; log: ${path.relative(root, logPath)}`);
  if (!status.ok) process.exit(1);
}

main().catch(async (error) => {
  await mkdir(logDir, { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({ topic: 'opensource-curation', runDate, startedAt, finishedAt: new Date().toISOString(), ok: false, error: error.stack || error.message, steps: [] }, null, 2),
  );
  console.error(error);
  process.exit(1);
});
