import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('./lib/run-daily-pipeline.mjs', import.meta.url).href;
const command = (name, code = '') => [name, process.execPath, ['-e', code]];

async function fixture({ candidates = [], collectCode = 0, draftCode = 0, gated = true,
  payload = { topic: 'lens', candidates }, buildCode = 0 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-blog-empty-candidates-'));
  try {
    const steps = [
      command('collect', `process.exit(${collectCode})`),
      command('draft', `require('fs').writeFileSync('candidates.json', ${JSON.stringify(JSON.stringify(payload))}); process.exit(${draftCode})`),
      ...['research', 'rewrite', 'publish'].map(name => command(name,
        candidates.length ? `require('fs').writeFileSync('${name}.ran','yes')` : 'process.exit(1)')),
      command('build', `require('fs').writeFileSync('build.ran','yes');process.exit(${buildCode})`),
    ];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const {runPipeline}=await import(${JSON.stringify(moduleUrl)});
      await runPipeline(${JSON.stringify({ topic:'lens',logTitle:'Test',runDate:'2026-10-04',
        steps, ...(gated ? { emptyCandidatesPath: 'candidates.json' } : {}) })});
    `], { cwd: root, encoding: 'utf8' });
    const status = JSON.parse(await readFile(path.join(root, 'logs/daily/lens-latest-status.json'), 'utf8'));
    const log = await readFile(path.join(root, 'logs/daily/lens-latest.log'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    return { exit: result.status, status, files: await readdir(root), log };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('empty candidates skip AI and publication, build successfully, and exit zero', async () => {
  const { exit, status, files, log } = await fixture();
  assert.equal(exit, 0);
  assert.equal(status.ok, true);
  assert.equal(status.publicationSkipped, true);
  assert.equal(status.skipReason, 'no_candidates');
  for (const name of ['research','rewrite','publish']) {
    const step=status.steps.find(s=>s.name===name);
    assert.equal(step.skipped,true);
    assert.equal(step.skipReason,'no_candidates');
    assert.equal(step.code,null);
    assert.equal(files.includes(`${name}.ran`),false);
  }
  assert.ok(files.includes('build.ran'));
  assert.match(log,/no_candidates/);
});

test('nonempty candidates execute the existing pipeline unchanged', async () => {
  const {exit,status,files}=await fixture({candidates:[{id:'one'}]});
  assert.equal(exit,0);
  assert.equal(status.ok,true);
  assert.notEqual(status.publicationSkipped,true);
  for(const name of ['research','rewrite','publish','build']) assert.ok(files.includes(`${name}.ran`));
});

test('collection failure remains an error instead of empty-candidate success', async () => {
  const {exit,status,files}=await fixture({collectCode:1});
  assert.equal(exit,1);
  assert.equal(status.ok,false);
  assert.equal(status.steps[0].name,'collect');
  assert.equal(status.steps.length,1);
  assert.notEqual(status.publicationSkipped,true);
  assert.equal(files.includes('build.ran'),false);
});

test('failed draft cannot trigger successful empty-candidate skip', async () => {
  const {exit,status}=await fixture({draftCode:1});
  assert.equal(exit,1);
  assert.equal(status.ok,false);
  assert.notEqual(status.publicationSkipped,true);
});

test('invalid candidate payload fails rather than treating corrupt input as empty', async () => {
  const {exit,status}=await fixture({payload:{topic:'lens'}});
  assert.equal(exit,1);
  assert.equal(status.ok,false);
  assert.match(status.error,/expected candidates/);
});

test('candidate payload from another topic is an error', async () => {
  const {exit,status}=await fixture({payload:{topic:'other',candidates:[]}});
  assert.equal(exit,1);
  assert.equal(status.ok,false);
  assert.match(status.error,/expected candidates/);
});

test('empty candidate gate does not apply to pipelines that have not enabled it', async () => {
  const {exit,status}=await fixture({gated:false});
  assert.equal(exit,1);
  assert.equal(status.ok,false);
  assert.equal(status.steps.at(-1).name,'research');
});

test('build failure after an empty-candidate skip remains an error', async () => {
  const {exit,status}=await fixture({buildCode:1});
  assert.equal(exit,1);
  assert.equal(status.ok,false);
  assert.equal(status.steps.at(-1).name,'build');
});
