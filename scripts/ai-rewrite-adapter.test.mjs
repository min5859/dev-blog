import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AI_ADAPTER,
  normalizeDailyRewriteAdapter,
  parseNewsletterJsonFromAiOutput,
  resolveAiAdapter,
  runAiAdapterAndParse,
} from './lib/ai-rewrite-adapter.mjs';

test('normalizeDailyRewriteAdapter falls back to DEFAULT_AI_ADAPTER and maps cursor-agent alias', () => {
  assert.equal(normalizeDailyRewriteAdapter(''), DEFAULT_AI_ADAPTER);
  assert.equal(normalizeDailyRewriteAdapter('cursor-agent'), 'cursor');
  assert.equal(normalizeDailyRewriteAdapter('cursor'), 'cursor');
  assert.equal(normalizeDailyRewriteAdapter('claude'), 'claude');
});

test('resolveAiAdapter without args returns DEFAULT_AI_ADAPTER when env unset', () => {
  delete process.env.AI_ADAPTER;
  assert.equal(resolveAiAdapter(), DEFAULT_AI_ADAPTER);
});

test('parseNewsletterJsonFromAiOutput unwraps Cursor CLI json result envelope', () => {
  const inner = {
    id: 'x',
    topic: 'linux',
    title: 't',
    date: '2026-01-01',
    summary: 's',
    sections: [{ heading: 'a', body: 'b' }],
    sources: [{ title: 'u', url: 'https://u', note: 'n' }],
    highlights: [{ title: 'h', priority: '상', verifyLink: '없음', action: 'a' }],
  };
  const wrapped = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(inner),
  });
  const out = parseNewsletterJsonFromAiOutput(wrapped);
  assert.equal(out.id, 'x');
});

test('parseNewsletterJsonFromAiOutput accepts raw JSON from Claude', () => {
  const inner = { id: 'y', topic: 'linux' };
  const out = parseNewsletterJsonFromAiOutput(JSON.stringify(inner));
  assert.equal(out.id, 'y');
});

test('resolveAiAdapter maps cursor-agent alias', () => {
  process.env.AI_ADAPTER = 'cursor-agent';
  assert.equal(resolveAiAdapter('template'), 'cursor');
  delete process.env.AI_ADAPTER;
});

test('parseNewsletterJsonFromAiOutput finds result envelope inside NDJSON stream', () => {
  const newsletter = {
    id: 'z',
    topic: 'linux',
    title: 't',
    date: '2026-05-11',
    summary: 's',
    sections: [{ heading: 'a', body: 'b' }],
    sources: [{ title: 'u', url: 'https://u', note: 'n' }],
    highlights: [{ title: 'h', priority: '상', verifyLink: '없음', action: 'a' }],
  };
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '…' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(newsletter) }),
  ].join('\n');
  const out = parseNewsletterJsonFromAiOutput(stream);
  assert.equal(out.id, 'z');
  assert.equal(out.sections.length, 1);
});

test('runAiAdapterAndParse retries once on parse failure and dumps raw to failure dir', async () => {
  const failureDir = await mkdtemp(path.join(tmpdir(), 'dev-blog-rewrite-failure-'));
  try {
    const newsletter = {
      id: 'r',
      topic: 'linux',
      title: 't',
      date: '2026-05-18',
      summary: 's',
      sections: [{ heading: 'a', body: 'b' }],
      sources: [{ title: 'u', url: 'https://u', note: 'n' }],
      highlights: [{ title: 'h', priority: '상', verifyLink: '없음', action: 'a' }],
    };
    let call = 0;
    const runner = async () => {
      call += 1;
      if (call === 1) return 'I am sorry, here is no JSON for you.';
      return JSON.stringify(newsletter);
    };
    const result = await runAiAdapterAndParse('prompt', { runner, logLabel: 'retry-test', failureDir });
    assert.equal(call, 2);
    assert.equal(result.post.id, 'r');
    const dumped = await readdir(failureDir);
    assert.equal(dumped.length, 1);
    const body = await readFile(path.join(failureDir, dumped[0]), 'utf8');
    assert.match(body, /label: retry-test/);
    assert.match(body, /attempt: 1/);
    assert.match(body, /I am sorry, here is no JSON for you\./);
  } finally {
    await rm(failureDir, { recursive: true, force: true });
  }
});

test('runAiAdapterAndParse throws after exhausting retries and dumps every attempt', async () => {
  const failureDir = await mkdtemp(path.join(tmpdir(), 'dev-blog-rewrite-failure-'));
  try {
    const runner = async () => 'still not json';
    await assert.rejects(
      runAiAdapterAndParse('prompt', { runner, logLabel: 'always-fail', failureDir }),
      /AI response did not contain JSON/,
    );
    const dumped = await readdir(failureDir);
    assert.equal(dumped.length, 2);
  } finally {
    await rm(failureDir, { recursive: true, force: true });
  }
});

test('runAiAdapterAndParse returns null when adapter returns null (template mode)', async () => {
  const runner = async () => null;
  const result = await runAiAdapterAndParse('prompt', { runner, logLabel: 'template' });
  assert.equal(result, null);
});

test('parseNewsletterJsonFromAiOutput tolerates trailing text after newsletter JSON', () => {
  const newsletter = {
    id: 'q',
    topic: 'linux',
    title: 't',
    date: '2026-05-11',
    summary: 's',
    sections: [{ heading: 'a', body: 'b' }],
    sources: [{ title: 'u', url: 'https://u', note: 'n' }],
    highlights: [{ title: 'h', priority: '상', verifyLink: '없음', action: 'a' }],
  };
  const noisy = `${JSON.stringify(newsletter)}\nDone.`;
  const out = parseNewsletterJsonFromAiOutput(noisy);
  assert.equal(out.id, 'q');
});

test('parseNewsletterJsonFromAiOutput skips malformed draft JSON before final newsletter JSON', () => {
  const newsletter = {
    id: 'final',
    topic: 'linux',
    title: 't',
    date: '2026-05-23',
    summary: 's',
    sections: [{ heading: 'a', body: 'b' }],
    sources: [{ title: 'u', url: 'https://u', note: 'n' }],
    highlights: [{ title: 'h', priority: '상', verifyLink: '없음', action: 'a' }],
  };
  const wrapped = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: [
      '초안 작성 중입니다.',
      '{"id":"broken","topic":"linux","sections":[{"heading":"a","body":"unterminated"',
      '최종 JSON만 출력합니다.',
      JSON.stringify(newsletter),
    ].join('\n'),
  });
  const out = parseNewsletterJsonFromAiOutput(wrapped);
  assert.equal(out.id, 'final');
});

test('runAiAdapterAndParse appends 재시도 correction instruction on second attempt only', async () => {
  const failureDir = await mkdtemp(path.join(tmpdir(), 'dev-blog-rewrite-failure-'));
  try {
    const newsletter = {
      id: 'retry-ok',
      topic: 'linux',
      title: 't',
      date: '2026-07-23',
      summary: 's',
      sections: [{ heading: 'a', body: 'b' }],
      sources: [{ title: 'u', url: 'https://u', note: 'n' }],
      highlights: [{ title: 'h', priority: '상', verifyLink: '없음', action: 'a' }],
    };
    const seenPrompts = [];
    let call = 0;
    const runner = async (p) => {
      seenPrompts.push(p);
      call += 1;
      if (call === 1) return '이 파일은 이미 유효하니 수정할 필요가 없습니다.';
      return JSON.stringify(newsletter);
    };
    const result = await runAiAdapterAndParse('원본 프롬프트', { runner, logLabel: 'retry-correction', failureDir });
    assert.equal(call, 2);
    assert.equal(result.post.id, 'retry-ok');
    assert.doesNotMatch(seenPrompts[0], /재시도/);
    assert.match(seenPrompts[1], /\[재시도\]/);
    assert.match(seenPrompts[1], /원본 프롬프트/); // 원본 prompt 는 보존되고 뒤에 덧붙는지 확인
  } finally {
    await rm(failureDir, { recursive: true, force: true });
  }
});

test('runAiAdapterAndParse failure dump records resolved adapter and model in header', async () => {
  const failureDir = await mkdtemp(path.join(tmpdir(), 'dev-blog-rewrite-failure-'));
  try {
    delete process.env.AI_ADAPTER;
    delete process.env.CLAUDE_MODEL;
    const runner = async () => 'not json at all';
    await assert.rejects(
      runAiAdapterAndParse('prompt', { runner, logLabel: 'adapter-model-header', failureDir }),
      /AI response did not contain JSON/,
    );
    const dumped = await readdir(failureDir);
    assert.equal(dumped.length, 2);
    const body = await readFile(path.join(failureDir, dumped[0]), 'utf8');
    assert.match(body, /# adapter: claude/);
    assert.match(body, /# model: claude-sonnet-5/);
  } finally {
    await rm(failureDir, { recursive: true, force: true });
  }
});

test('runAiAdapterAndParse retries when parsed post fails validation', async () => {
  const failureDir = await mkdtemp(path.join(tmpdir(), 'dev-blog-rewrite-failure-'));
  try {
    const bad = { id: 'bad', topic: 'linux' };
    const good = { id: 'good', topic: 'linux' };
    let call = 0;
    const runner = async () => {
      call += 1;
      return JSON.stringify(call === 1 ? bad : good);
    };
    const result = await runAiAdapterAndParse('prompt', {
      runner,
      logLabel: 'validator-retry',
      failureDir,
      postValidator: (post) => {
        if (post.id === 'bad') throw new Error('bad post');
      },
    });
    assert.equal(result.post.id, 'good');
    assert.equal(call, 2);
    const dumped = await readdir(failureDir);
    assert.equal(dumped.length, 1);
    const body = await readFile(path.join(failureDir, dumped[0]), 'utf8');
    assert.match(body, /bad post/);
  } finally {
    await rm(failureDir, { recursive: true, force: true });
  }
});
