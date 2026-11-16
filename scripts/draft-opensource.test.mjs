import test from 'node:test';
import assert from 'node:assert/strict';

import { filterOutForeignCjk } from './draft-opensource.mjs';

function repo(overrides = {}) {
  return {
    id: 'gh:example/repo',
    title: 'example/repo',
    metadata: { fullName: 'example/repo', description: 'a demo repo', stars: 100 },
    ...overrides,
  };
}

test('filterOutForeignCjk keeps English/Korean repos', () => {
  const records = [repo(), repo({ id: 'gh:2', metadata: { fullName: 'foo/bar', description: '리눅스 커널 도구' } })];
  assert.deepEqual(filterOutForeignCjk(records).map((r) => r.id), ['gh:example/repo', 'gh:2']);
});

test('filterOutForeignCjk drops repos whose name+description is mostly Chinese', () => {
  const records = [
    repo(),
    repo({
      id: 'gh:cjk',
      metadata: { fullName: 'foo/bar', description: '《动手学大模型》系列编程实践教程' },
    }),
  ];
  assert.deepEqual(filterOutForeignCjk(records).map((r) => r.id), ['gh:example/repo']);
});

test('filterOutForeignCjk can drop repos whose README is mostly Chinese despite an English description', () => {
  const readme = (record) => record.readmeExcerpt || '';
  const records = [
    repo({ readmeExcerpt: 'A fast media player. Install it with cargo.' }),
    repo({
      id: 'gh:readme-cjk',
      metadata: { fullName: 'Minireel/HGhub', description: 'Plug-in media player' },
      readmeExcerpt: 'HGhub 一个通过插件连接内容的通用视频播放器。开始使用',
    }),
  ];
  assert.deepEqual(filterOutForeignCjk(records).map((r) => r.id), ['gh:example/repo', 'gh:readme-cjk']);
  assert.deepEqual(filterOutForeignCjk(records, readme, 'README').map((r) => r.id), ['gh:example/repo']);
});
