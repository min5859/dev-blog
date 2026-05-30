import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();

function runStep(name, command, args, extraEnv = {}) {
  const stepStartedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
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

function renderLog(logTitle, status) {
  const lines = [
    `# ${logTitle} ${status.runDate}`,
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
    if (step.stdout) lines.push('stdout:', '```', step.stdout, '```');
    if (step.stderr) lines.push('stderr:', '```', step.stderr, '```');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// steps: [[name, command, args, extraEnv?], ...]
// NEWSLETTER_DATE is injected automatically via extraEnv on every step.
export async function runPipeline({ topic, logTitle, steps, runDate, extraStatus = {} }) {
  const logDir = path.join(root, 'logs', 'daily');
  const logPath = path.join(logDir, `${runDate}-${topic}.log`);
  const latestLogPath = path.join(logDir, `${topic}-latest.log`);
  const statusPath = path.join(logDir, `${topic}-latest-status.json`);
  const startedAt = new Date().toISOString();

  await mkdir(logDir, { recursive: true });

  const results = [];
  try {
    for (const [name, command, args, extraEnv = {}] of steps) {
      const result = await runStep(name, command, args, { NEWSLETTER_DATE: runDate, ...extraEnv });
      results.push(result);
      if (!result.ok) break;
    }

    const status = {
      topic,
      runDate,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: results.every((r) => r.ok) && results.length === steps.length,
      steps: results,
      ...extraStatus,
    };

    const log = renderLog(logTitle, status);
    await writeFile(logPath, log);
    await writeFile(latestLogPath, log);
    await writeFile(statusPath, JSON.stringify(status, null, 2));

    console.log(`[${topic}] pipeline ${status.ok ? 'succeeded' : 'failed'}; log: ${path.relative(root, logPath)}`);
    if (!status.ok) process.exit(1);
  } catch (error) {
    const status = {
      topic,
      runDate,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: error.stack || error.message,
      steps: results,
    };
    await writeFile(statusPath, JSON.stringify(status, null, 2));
    console.error(error);
    process.exit(1);
  }
}
