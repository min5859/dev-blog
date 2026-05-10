import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewsletterJsonFromAiOutput, resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';

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
