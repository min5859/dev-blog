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
 * Cursor 가 NDJSON (stream-json) 으로 떨어지는 경우도 흡수: 첫 `{`부터 균형 잡힌 JSON 값들을
 * 순회하며 `type === 'result'` 봉투를 찾고, 못 찾으면 가장 큰 객체를 채택한다.
 */
export function parseNewsletterJsonFromAiOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('AI response was empty');

  const single = tryJsonParse(trimmed);
  if (single) {
    if (isResultEnvelope(single)) {
      const unwrapped = unwrapResultEnvelope(single);
      if (unwrapped) return unwrapped;
      throw new Error('AI result envelope did not contain newsletter JSON');
    }
    return single;
  }

  const values = collectJsonValues(trimmed);
  for (const value of values) {
    const unwrapped = unwrapResultEnvelope(value);
    if (unwrapped) return unwrapped;
  }
  const newsletterCandidate = values.find(looksLikeNewsletter);
  if (newsletterCandidate) return newsletterCandidate;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = tryJsonParse(fenced[1].trim());
    if (parsed) return parsed;
  }

  throw new Error('AI response did not contain JSON');
}

function tryJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isResultEnvelope(value) {
  return Boolean(value && typeof value === 'object' && value.type === 'result' && typeof value.result === 'string');
}

function unwrapResultEnvelope(value) {
  if (!isResultEnvelope(value)) return null;
  const resultText = value.result.trim();
  if (!resultText) return null;
  const direct = tryJsonParse(resultText);
  if (direct) return direct;
  const fenced = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = tryJsonParse(fenced[1].trim());
    if (parsed) return parsed;
  }
  for (const candidate of collectJsonValues(resultText)) {
    if (looksLikeNewsletter(candidate)) return candidate;
  }
  return null;
}

function looksLikeNewsletter(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.topic === 'string' &&
      Array.isArray(value.sections),
  );
}

function collectJsonValues(text) {
  const values = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start < 0) break;
    const end = findMatchingBrace(text, start);
    if (end < 0) break;
    const slice = text.slice(start, end + 1);
    const parsed = tryJsonParse(slice);
    if (parsed) values.push(parsed);
    i = end + 1;
  }
  return values;
}

function findMatchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
