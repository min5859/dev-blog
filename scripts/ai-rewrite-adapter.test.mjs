import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDailyRewriteAdapter, parseNewsletterJsonFromAiOutput, resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';

test('normalizeDailyRewriteAdapter defaults empty to claude and maps cursor-agent alias', () => {
  assert.equal(normalizeDailyRewriteAdapter(''), 'claude');
  assert.equal(normalizeDailyRewriteAdapter('cursor-agent'), 'cursor');
  assert.equal(normalizeDailyRewriteAdapter('cursor'), 'cursor');
  assert.equal(normalizeDailyRewriteAdapter('claude'), 'claude');
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
