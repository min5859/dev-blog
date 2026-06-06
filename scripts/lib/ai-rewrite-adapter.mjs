import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * AI_ADAPTER: template | claude | codex | cursor (별칭 cursor-agent → cursor)
 * Claude: CLAUDE_BIN, CLAUDE_ARGS (기본 `-p`), stdin으로 프롬프트 전달
 * Codex: `codex exec -` (stdin) + `-o` 임시 파일로 출력 수집
 * Cursor CLI: CURSOR_AGENT_BIN (기본 `agent`), CURSOR_AGENT_EXTRA_ARGS — 프롬프트는 임시 파일 + file 경로 안내
 *
 * 기본 어댑터는 아래 DEFAULT_AI_ADAPTER 한 곳에서만 바꾼다.
 * 모든 ai-rewrite-*.mjs / run-daily-*.mjs 는 이 상수를 통해 default를 받는다.
 */
export const DEFAULT_AI_ADAPTER = 'codex';

export function normalizeDailyRewriteAdapter(raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === 'cursor-agent') return 'cursor';
  if (!v) return DEFAULT_AI_ADAPTER;
  return v;
}

export function resolveAiAdapter(defaultValue = DEFAULT_AI_ADAPTER) {
  const raw = process.env.AI_ADAPTER?.trim();
  if (!raw) return defaultValue;
  if (raw === 'cursor-agent') return 'cursor';
  return raw;
}

function spawnCollectingStdout(command, args, prompt, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(prompt);
  });
}

function runClaudeStdin(prompt) {
  const command = process.env.CLAUDE_BIN || 'claude';
  const model = process.env.CLAUDE_MODEL || 'sonnet';
  const args = (process.env.CLAUDE_ARGS || `-p --model ${model} --output-format text`).split(/\s+/).filter(Boolean);
  return spawnCollectingStdout(command, args, prompt);
}

/**
 * Research 전용 Claude 호출. 닫힌 rewrite 와 달리 read-only 도구 allowlist 를 부여한다.
 * 도구 이름에 공백이 들어갈 수 있으므로(`Bash(git log:*)`) 콤마 구분 후 개별 인자로 넘긴다.
 * 설계: docs/RESEARCH-WRITE-SPLIT.md §4
 */
function runClaudeResearch(prompt) {
  const command = process.env.CLAUDE_BIN || 'claude';
  const model = process.env.CLAUDE_MODEL || 'sonnet';
  const tools = (process.env.CLAUDE_RESEARCH_TOOLS || 'WebFetch,WebSearch,Bash(git log:*)')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const args = ['-p', '--model', model, '--output-format', 'text', '--allowedTools', ...tools];
  // §7 결정 #4: tool-enabled 호출은 무한정 hang 할 수 있으므로 wall-clock budget 을 건다.
  // 기본 10분, CLAUDE_RESEARCH_TIMEOUT_MS 로 조정(0 이면 무제한).
  const timeoutMs = Number(process.env.CLAUDE_RESEARCH_TIMEOUT_MS ?? 600000);
  return spawnCollectingStdout(command, args, prompt, { timeoutMs });
}

/**
 * Research 전용 Cursor 호출. rewrite 의 `--mode=ask`(읽기 질의) 대신 `--force`(도구 허용)로
 * 능동 조사를 시킨다. wall-clock budget 으로 hang 방지(claude 와 동일 정책).
 */
async function runCursorResearch(prompt) {
  const command = process.env.CURSOR_AGENT_BIN || 'agent';
  const model = process.env.CURSOR_MODEL || 'claude-4.6-sonnet-medium';
  const extra = (process.env.CURSOR_AGENT_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
  const timeoutMs = Number(process.env.CLAUDE_RESEARCH_TIMEOUT_MS ?? 600000);
  const dir = await mkdtemp(path.join(tmpdir(), 'dev-blog-research-'));
  const promptFile = path.join(dir, 'prompt.md');
  try {
    await writeFile(promptFile, prompt, 'utf8');
    const userMessage = [
      'Read the file at the absolute path below. It contains research instructions and candidate JSON.',
      'Use your available tools (web fetch/search) to investigate, then reply with a single valid dossier JSON object only.',
      'No markdown code fences, no commentary before or after the JSON.',
      '',
      `File: ${promptFile}`,
    ].join('\n');
    const args = ['-p', '--model', model, '--output-format', 'json', '--force', ...extra, userMessage];
    return await spawnCollectingStdout(command, args, '', { timeoutMs });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Research 단계 어댑터. tool-capable 어댑터(claude/codex/cursor)는 실제 조사를 수행하고,
 * template 은 null 을 반환해 호출부가 deterministic dossier fallback 으로 떨어지게 한다.
 * - claude: read-only 도구 allowlist
 * - codex : codex exec 의 샌드박스 도구
 * - cursor: --force 도구 허용 모드
 * @returns {Promise<string|null>}
 */
export async function runResearchAdapterPrompt(prompt, { defaultAdapter = DEFAULT_AI_ADAPTER } = {}) {
  const adapter = resolveAiAdapter(defaultAdapter);
  if (adapter === 'claude') return runClaudeResearch(prompt);
  if (adapter === 'codex') return runCodexExec(prompt);
  if (adapter === 'cursor') return runCursorResearch(prompt);
  return null;
}

async function runCursorAgentFilePrompt(prompt) {
  const command = process.env.CURSOR_AGENT_BIN || 'agent';
  const model = process.env.CURSOR_MODEL || 'claude-4.6-sonnet-medium';
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

    const args = ['-p', '--model', model, '--output-format', 'json', '--mode=ask', ...extra, userMessage];
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

async function runCodexExec(prompt) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dev-blog-codex-'));
  const outFile = path.join(dir, 'output.md');
  const model = process.env.CODEX_MODEL || '';
  try {
    const cmd = ['codex', 'exec', '-', '-o', outFile, '--ephemeral'];
    if (model) cmd.push('-m', model);
    const output = await new Promise((resolve, reject) => {
      const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`codex exited with ${code}: ${stderr}`));
          return;
        }
        readFile(outFile, 'utf8').then(resolve).catch(reject);
      });
      child.stdin.end(prompt);
    });
    return output.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @returns {Promise<string|null>} 원시 stdout 텍스트; template이면 null
 */
export async function runAiAdapterPrompt(prompt, { defaultAdapter = DEFAULT_AI_ADAPTER } = {}) {
  const adapter = resolveAiAdapter(defaultAdapter);
  if (adapter === 'template') return null;
  if (adapter === 'claude') return runClaudeStdin(prompt);
  if (adapter === 'codex') return runCodexExec(prompt);
  if (adapter === 'cursor') return runCursorAgentFilePrompt(prompt);
  throw new Error(`Unsupported AI_ADAPTER: ${adapter}. Use template, claude, codex, or cursor.`);
}

/**
 * 어댑터 호출 + JSON 파싱을 한 번에 처리한다. 파싱 실패 시 raw 응답을 덤프하고 1회 재시도한다.
 * 반환: `{ raw, post }` (어댑터 호출 시) 또는 `null` (template 모드).
 *
 * options.runner 는 테스트용 주입 지점. 기본은 runAiAdapterPrompt.
 */
export async function runAiAdapterAndParse(prompt, options = {}) {
  const {
    defaultAdapter = DEFAULT_AI_ADAPTER,
    logLabel = 'ai-rewrite',
    maxAttempts = 2,
    failureDir,
    runner = runAiAdapterPrompt,
    postValidator = null,
  } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await runner(prompt, { defaultAdapter });
    if (raw === null) return null;
    try {
      const post = parseNewsletterJsonFromAiOutput(raw);
      if (postValidator) postValidator(post);
      return { raw, post };
    } catch (err) {
      lastError = err;
      const dumpPath = await dumpFailedAiResponse({ label: logLabel, raw, err, attempt, dir: failureDir });
      const where = dumpPath ? ` raw saved to ${dumpPath}` : '';
      console.warn(
        `[ai-rewrite][${logLabel}] attempt ${attempt}/${maxAttempts} parse failed: ${err.message};${where}`,
      );
    }
  }
  throw lastError ?? new Error('AI response parse failed');
}

async function dumpFailedAiResponse({ label, raw, err, attempt, dir }) {
  try {
    const root = dir || process.env.AI_REWRITE_FAILURE_DIR || path.join(process.cwd(), 'logs', 'ai-rewrite-failures');
    await mkdir(root, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label).replace(/[^a-zA-Z0-9._-]+/g, '_');
    const file = path.join(root, `${ts}-${safeLabel}-attempt${attempt}.txt`);
    const header = [
      '# ai-rewrite parse failure',
      `# label: ${label}`,
      `# attempt: ${attempt}`,
      `# timestamp: ${new Date().toISOString()}`,
      `# error: ${err.message}`,
      '---',
      '',
    ].join('\n');
    await writeFile(file, header + raw, 'utf8');
    return file;
  } catch {
    return null;
  }
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

/**
 * 임의의 AI stdout 에서 predicate 를 만족하는 JSON 객체를 추출한다 (newsletter 가 아닌
 * dossier 등 다른 스키마용). 순수 JSON → result 봉투 → 본문 내 균형 객체 → 코드펜스 순으로 시도.
 */
export function extractJsonObject(text, predicate = () => true) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const single = tryJsonParse(trimmed);
  if (single) {
    if (isResultEnvelope(single)) {
      // result 가 순수 JSON 이거나 "설명 텍스트 + JSON" 혼합일 수 있으므로 재귀 추출.
      const inner = extractJsonObject(single.result, predicate);
      if (inner) return inner;
    } else if (predicate(single)) {
      return single;
    }
  }
  for (const value of collectJsonValues(trimmed)) {
    if (isResultEnvelope(value)) {
      const inner = extractJsonObject(value.result, predicate);
      if (inner) return inner;
    } else if (predicate(value)) {
      return value;
    }
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = tryJsonParse(fenced[1].trim());
    if (parsed && predicate(parsed)) return parsed;
  }
  return null;
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
  const candidates = collectJsonValues(resultText).filter(looksLikeNewsletter);
  for (const candidate of candidates.toReversed()) {
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
    if (end < 0) {
      i = start + 1;
      continue;
    }
    const slice = text.slice(start, end + 1);
    const parsed = tryJsonParse(slice);
    if (parsed) values.push(parsed);
    i = parsed ? end + 1 : start + 1;
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
