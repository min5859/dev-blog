import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * AI_ADAPTER: template | claude | cursor (별칭 cursor-agent → cursor)
 * Claude: CLAUDE_BIN, CLAUDE_ARGS (기본 `-p`), stdin으로 프롬프트 전달
 * Cursor CLI: CURSOR_AGENT_BIN (기본 `agent`), CURSOR_AGENT_EXTRA_ARGS — 프롬프트는 임시 파일 + file 경로 안내
 */
export function normalizeDailyRewriteAdapter(raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || v === 'cursor-agent') return 'cursor';
  return v;
}

export function resolveAiAdapter(defaultValue = 'template') {
  const raw = process.env.AI_ADAPTER?.trim();
  if (!raw) return defaultValue;
  if (raw === 'cursor-agent') return 'cursor';
  return raw;
}

function runClaudeStdin(prompt) {
  const command = process.env.CLAUDE_BIN || 'claude';
  const args = (process.env.CLAUDE_ARGS || '-p').split(/\s+/).filter(Boolean);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(prompt);
  });
}

async function runCursorAgentFilePrompt(prompt) {
  const command = process.env.CURSOR_AGENT_BIN || 'agent';
  const extra = (process.env.CURSOR_AGENT_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
  const dir = await mkdtemp(path.join(tmpdir(), 'dev-blog-rewrite-'));
  const promptFile = path.join(dir, 'prompt.md');
  try {
    await writeFile(promptFile, prompt, 'utf8');
    const userMessage = [
      'Read the file at the absolute path below. It contains complete newsletter rewrite instructions and input JSON.',
      'Follow those instructions exactly. Reply with a single valid JSON object only (the newsletter post).',
      'No markdown code fences, no commentary before or after the JSON.',
      '',
      `File: ${promptFile}`,
    ].join('\n');

    const args = ['-p', '--output-format', 'json', '--mode=ask', ...extra, userMessage];
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: process.cwd(),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @returns {Promise<string|null>} 원시 stdout 텍스트; template이면 null
 */
export async function runAiAdapterPrompt(prompt, { defaultAdapter = 'template' } = {}) {
  const adapter = resolveAiAdapter(defaultAdapter);
  if (adapter === 'template') return null;
  if (adapter === 'claude') return runClaudeStdin(prompt);
  if (adapter === 'cursor') return runCursorAgentFilePrompt(prompt);
  throw new Error(`Unsupported AI_ADAPTER: ${adapter}. Use template, claude, or cursor.`);
}

/**
 * Claude stdout / Cursor `--output-format json`의 result 문자열 / fenced JSON 모두 처리
 */
export function parseNewsletterJsonFromAiOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('AI response was empty');

  let payload = trimmed;
  try {
    const outer = JSON.parse(trimmed);
    if (outer && typeof outer === 'object' && outer.type === 'result' && typeof outer.result === 'string') {
      payload = outer.result.trim();
    }
  } catch {
    // 전체가 뉴스레터 JSON이거나 마크다운 등
  }

  try {
    return JSON.parse(payload);
  } catch {
    const match = payload.match(/```(?:json)?\s*([\s\S]*?)```/) || payload.match(/({[\s\S]*})/);
    if (!match) throw new Error('AI response did not contain JSON');
    return JSON.parse(match[1]);
  }
}
