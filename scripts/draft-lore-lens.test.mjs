import test from 'node:test';
import assert from 'node:assert/strict';

import { isReleaseRelevantForLens, isRelevantToLens, pickCandidatesLens } from './draft-lore-lens.mjs';

const baseLore = {
  id: 'lore:1',
  sourceId: 'lore-linux-hardening',
  source: 'lore.kernel.org/linux-hardening',
  kind: 'patch-discussion',
  observedDate: '2026-05-23',
  title: 'firmware: raspberrypi: register nvmem driver',
  summary: 'board-local firmware driver',
  url: 'https://lore.kernel.org/linux-hardening/x/',
  metadata: { loreList: 'linux-hardening', excerpt: 'Raspberry Pi firmware nvmem driver' },
  tags: ['kernel', 'patch-discussion'],
};

test('isReleaseRelevantForLens keeps only configured release monikers', () => {
  const stable = { sourceId: 'kernel-org-releases', metadata: { moniker: 'stable' } };
  const mainline = { sourceId: 'kernel-org-releases', metadata: { moniker: 'mainline' } };
  const pipeline = { releaseMonikers: ['stable', 'longterm'] };
  assert.equal(isReleaseRelevantForLens(stable, pipeline), true);
  assert.equal(isReleaseRelevantForLens(mainline, pipeline), false);
});

test('isRelevantToLens excludes configured board-local noise', () => {
  const pipeline = {
    relevanceIncludePatterns: ['hardening', 'struct_size', 'security'],
    relevanceExcludePatterns: ['raspberry\\s*pi', '\\bnvmem\\b'],
  };
  assert.equal(isRelevantToLens(baseLore, pipeline), false);
});

test('isRelevantToLens keeps direct hardening signals', () => {
  const record = {
    ...baseLore,
    title: 'kernel/params: use DEFINE_KERNEL_PARAM_OPS for hardening',
    summary: 'kernel parameter initialization hardening',
    metadata: { ...baseLore.metadata, excerpt: 'hardening struct layout changes' },
  };
  const pipeline = {
    relevanceIncludePatterns: ['hardening', 'kernel_param', 'parameter'],
    relevanceExcludePatterns: ['raspberry\\s*pi'],
  };
  assert.equal(isRelevantToLens(record, pipeline), true);
});

test('pickCandidatesLens applies relevance filters before broad-impact selection', () => {
  const records = [
    baseLore,
    {
      ...baseLore,
      id: 'lore:2',
      title: '[PATCH] kernel/params: use DEFINE_KERNEL_PARAM_OPS',
      summary: 'hardening parameter initialization',
      metadata: { ...baseLore.metadata, excerpt: 'hardening parameter' },
    },
  ];
  const picked = pickCandidatesLens(records, {
    relevanceIncludePatterns: ['hardening', 'kernel_param', 'parameter'],
    relevanceExcludePatterns: ['raspberry\\s*pi', '\\bnvmem\\b'],
  });
  assert.deepEqual(picked.map((r) => r.id), ['lore:2']);
});
