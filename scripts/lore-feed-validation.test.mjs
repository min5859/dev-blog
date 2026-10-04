import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectLoreAtomTopic } from './lib/kernel-lore-shared.mjs';

async function collect(t, body, status=200) {
  const dir=await mkdtemp(path.join(tmpdir(),'dev-blog-feed-'));
  t.mock.method(globalThis,'fetch',async()=>new Response(body,{status}));
  try {
    return await collectLoreAtomTopic({source:{id:'feed',url:'https://lore.kernel.org/dri-devel/new.atom'},
      topic:'linux-gpu-ai',rawDir:dir,collectedAt:'2026-10-04T00:00:00Z',runId:'2026-10-04'});
  } finally {await rm(dir,{recursive:true,force:true});}
}

test('a valid empty Atom feed is successful collection', async t => {
  assert.deepEqual((await collect(t,'<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).records,[]);
});
test('a self-closing empty Atom feed is successful collection', async t => {
  assert.deepEqual((await collect(t,'<feed xmlns="http://www.w3.org/2005/Atom"/>')).records,[]);
});
test('HTTP 200 HTML challenge is a collection error, not an empty Atom feed', async t => {
  await assert.rejects(collect(t,'<html>Making sure you are not a bot</html>'),/Atom feed/);
});
test('truncated Atom feed is a collection error', async t => {
  await assert.rejects(collect(t,'<feed xmlns="http://www.w3.org/2005/Atom">'),/Atom feed/);
});
test('HTTP failures still fail collection', async t => {
  await assert.rejects(collect(t,'unavailable',503),/503/);
});
test('valid Atom entries are collected normally', async t => {
  const d=await collect(t,'<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>one</id><title>[PATCH] GPU</title><updated>2026-10-04T00:00:00Z</updated><link href="https://lore.kernel.org/dri-devel/one/"/></entry></feed>');
  assert.equal(d.records.length,1);
  assert.equal(d.records[0].title,'[PATCH] GPU');
});
