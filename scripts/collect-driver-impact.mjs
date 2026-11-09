#!/usr/bin/env node
// 커널 git 두 태그 사이에서 드라이버에 영향을 주는 사실만 뽑아 data/raw/driver-impact/<from>..<to>.json 으로 남긴다.
// 네트워크·웹·lore 를 쓰지 않는다. --repo 에는 두 태그의 트리와 그 사이 커밋이 있어야 한다.
//   node scripts/collect-driver-impact.mjs --repo <linux.git> --from v7.3 --to v7.4-rc1
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  broadCommits, declaredName, diffExports, diffHeaderApi, exportName, filesByWord, findCampaigns, FOCUS_AREAS,
  headerStatus, kconfigName, mergeHeaderApis, parseExports, parseHeaderApi, parseKconfig, parsePull, patchLines, removalCommits,
} from './lib/driver-impact.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOT_TOOLS = [':(exclude)tools', ':(exclude)Documentation', ':(exclude)samples'];
const TRAILER_RE = /^(?:Signed-off-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Co-developed-by|Cc|Link|Closes|Message-ID|Fixes|Reported-and-tested-by):.*$/gim;

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  const value = at > 0 ? process.argv[at + 1] : process.env[`DRIVER_IMPACT_${name.toUpperCase()}`];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const repo = option('repo');
const from = option('from');
const to = option('to');
const range = `${from}..${to}`;

async function git(args, { allowNoMatch = false } = {}) {
  try {
    const { stdout } = await exec('git', ['-C', repo, ...args], { maxBuffer: 1 << 30, encoding: 'utf8' });
    return stdout;
  } catch (err) {
    if (allowNoMatch && err.code === 1 && !err.stderr) return ''; // git grep: 일치 없음
    throw err;
  }
}

const lines = (text) => text.split('\n').filter(Boolean);
const grep = (tag, pattern, paths) => git(['grep', '-E', pattern, tag, '--', ...paths], { allowNoMatch: true }).then(lines);

/** 이름 목록 중 tag 의 paths 안에 단어로 나타나는 것 → Map(name → Set(path)). */
async function wordFiles(tag, names, paths) {
  if (!names.length) return new Map();
  const dir = await mkdtemp(path.join(tmpdir(), 'driver-impact-'));
  try {
    const file = path.join(dir, 'names');
    await writeFile(file, `${names.join('\n')}\n`);
    return filesByWord(lines(await git(['grep', '-o', '-w', '-F', '-f', file, tag, '--', ...paths], { allowNoMatch: true })));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const patchLog = (pickaxe, paths) => git(['log', '--no-merges', '-p', '-U0', ...pickaxe, '--format=%x1e%H%x1f%s', range, '--', ...paths]);

function commitsWithFiles(text) {
  return text.split('\x1e').filter((b) => b.trim()).map((block) => {
    const [head, ...files] = block.split('\n').filter(Boolean);
    const [sha, subject] = head.split('\x1f');
    return { sha, subject, files };
  });
}

async function collectExports() {
  const pattern = 'EXPORT_SYMBOL[A-Z_]*[[:space:]]*\\(';
  const [before, after] = await Promise.all([from, to].map(async (tag) => parseExports(await grep(tag, pattern, ['.', ...NOT_TOOLS]))));
  const diff = diffExports(before, after);
  const by = removalCommits(patchLines(await patchLog(['-G', 'EXPORT_SYMBOL'], ['.', ...NOT_TOOLS])), exportName);
  // export 만 사라지고 헤더에 남은 이름은 inline·매크로(소스 호환)인지 선언만 남았는지(링크 실패) 가른다.
  const inHeader = await wordFiles(to, diff.removed.map((e) => e.name), ['include/']);
  const header = new Map();
  for (const name of inHeader.keys()) {
    header.set(name, headerStatus(name, await git(['grep', '-h', '-B1', '-w', '-e', name, to, '--', 'include/'], { allowNoMatch: true })));
  }
  return {
    removed: diff.removed.map((e) => ({ ...e, header: header.get(e.name) || 'gone', commit: by.get(e.name) || null })),
    changed: diff.changed,
    added: diff.added,
  };
}

async function collectHeaders(includeLog) {
  const by = removalCommits(patchLines(await includeLog), (text) => declaredName(text)?.name || null);
  const names = [...by.keys()];
  const [before, after] = await Promise.all([from, to].map((tag) => wordFiles(tag, names, ['include/'])));
  return names
    .filter((name) => before.has(name) && !after.has(name))
    .map((name) => {
      const { text, ...commit } = by.get(name);
      return { name, kind: declaredName(text).kind, file: commit.file, commit };
    });
}

// 새로 생긴 것은 함수·인자 있는 매크로·구조체 멤버만 남긴다(레지스터 상수·enum 값은 뺀다).
const isNewApi = (i) => i.kind === 'function' || i.kind === 'member' || (i.kind === 'macro' && i.after !== '');

/**
 * 중점 영역마다 범위 안에서 바뀐 헤더를 두 태그에서 파싱해 비교한다. 다른 헤더로 옮겨 간 이름은 빼고,
 * 삭제·변경은 이전 버전 드라이버가 쓰던 것만 남긴다.
 */
async function collectFocus(includeLog) {
  const changed = lines(await git(['diff', '--no-renames', '--name-only', from, to, '--', 'include/']));
  const show = (tag, file) => git(['show', `${tag}:${file}`]).catch(() => '');
  const areas = [];
  for (const area of FOCUS_AREAS) {
    const files = changed.filter((f) => area.headers.test(f));
    const api = async (tag) => mergeHeaderApis(await Promise.all(files.map(async (f) => parseHeaderApi(await show(tag, f), f))));
    const after = await api(to);
    areas.push({ area, files, after, items: diffHeaderApi(await api(from), after) });
  }
  const all = areas.flatMap((a) => a.items);
  const named = (change) => [...new Set(all.filter((i) => i.change === change && i.kind !== 'member').map((i) => i.name))];
  const [stillThere, wasThere] = await Promise.all([wordFiles(to, named('removed'), ['include/']), wordFiles(from, named('added'), ['include/'])]);
  const words = [...new Set(all.filter((i) => i.change !== 'added').flatMap((i) => (i.kind === 'member' ? [i.member, i.struct] : [i.name])))];
  const users = await wordFiles(from, words, ['drivers/', 'sound/']);

  // 남길 항목마다 그 헤더에서 이름이 나온 줄을 마지막으로 바꾼 커밋.
  const kept = areas.map(({ area, files, after, items }) => {
    const usedBy = (word) => [...(users.get(word) || [])].filter((f) => !area.sources.test(f));
    const list = items.filter((i) => !(i.change === 'removed' && i.kind !== 'member' && stillThere.has(i.name))
      && !(i.change === 'added' && i.kind !== 'member' && wasThere.has(i.name)));
    for (const i of list) {
      if (i.change === 'added') continue;
      const structFiles = i.kind === 'member' ? new Set(usedBy(i.struct)) : null;
      i.driverUses = i.kind === 'member' ? usedBy(i.member).filter((f) => structFiles.has(f)).length : usedBy(i.name).length;
    }
    const shown = list.filter((i) => (i.change === 'added' ? isNewApi(i) : i.driverUses > 0));
    // 멤버가 바뀐 구조체에서 그대로인 멤버: 요약·커밋 메시지가 더 많은 콜백이 바뀌었다고 해도 걸러 내는 근거다.
    const touched = shown.filter((i) => i.kind === 'member' && i.change !== 'added');
    const same = Object.fromEntries([...new Set(touched.map((i) => i.struct))].map((struct) => [struct,
      [...(after.structs.get(struct)?.members.keys() || [])].filter((m) => !items.some((i) => i.struct === struct && i.member === m))]));
    return { id: area.id, files: files.length, items: shown, same };
  });
  const wanted = new Map();
  for (const i of kept.flatMap((a) => a.items)) {
    if (!wanted.has(i.file)) wanted.set(i.file, new Set());
    wanted.get(i.file).add(i.member || i.name);
    if (i.struct) wanted.get(i.file).add(i.struct);
  }
  // 이름이 있는 줄은 그대로이고 다음 줄(인자)만 바뀐 경우는 hunk 머리의 구조체·함수 이름으로 찾는다.
  const hits = new Map();
  const around = new Map();
  for (const { sha, subject, file, text, context } of patchLines(await includeLog)) {
    const want = wanted.get(file);
    if (!want) continue;
    for (const [words, map] of [[text, hits], [context, around]]) {
      for (const w of words.match(/[A-Za-z_]\w*/g) || []) {
        if (want.has(w) && !map.has(`${file}\0${w}`)) map.set(`${file}\0${w}`, { sha, subject });
      }
    }
  }
  for (const i of kept.flatMap((a) => a.items)) {
    const key = (w) => `${i.file}\0${w}`;
    i.commit = hits.get(key(i.member || i.name)) || around.get(key(i.struct || i.name)) || null;
  }
  return kept;
}

async function collectKconfig() {
  const pattern = '^[[:space:]]*(menu)?config[[:space:]]+[A-Z0-9_]+';
  const [before, after] = await Promise.all([from, to].map(async (tag) => parseKconfig(await grep(tag, pattern, ['*Kconfig*']))));
  const by = removalCommits(patchLines(await patchLog(['-G', '^[[:space:]]*(menu)?config '], ['*Kconfig*'])), kconfigName);
  const removed = [...before].filter(([name]) => !after.has(name))
    .map(([name, file]) => ({ name, file, commit: by.get(name) || null }));
  return { removed, added: [...after.keys()].filter((name) => !before.has(name)).length };
}

async function collectPulls() {
  const bodies = (await git(['log', '--first-parent', '--merges', '--format=%x1e%H%x1f%s%x1f%b', range]))
    .split('\x1e').filter((b) => b.trim()).map((b) => b.split('\x1f'));
  const files = new Map(commitsWithFiles(await git([
    'log', '--first-parent', '--merges', '--diff-merges=first-parent', '--name-only', '--format=%x1e%H%x1f', range,
  ])).map((c) => [c.sha, c.files]));
  return bodies.map(([sha, subject, body]) => parsePull({ sha, subject, body: body || '', files: files.get(sha) || [] }));
}

async function collectDocs() {
  const deprecated = lines(await git(['diff', '-U0', from, to, '--', 'Documentation/process/deprecated.rst']))
    .filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
  const driverApi = lines(await git(['log', '--no-merges', '--format=%H%x1f%s', range, '--', 'Documentation/driver-api/']))
    .map((l) => { const [sha, subject] = l.split('\x1f'); return { sha, subject }; });
  return { deprecated, driverApi };
}

async function main() {
  const [fromCommit, toCommit] = lines(await git(['rev-parse', `${from}^{commit}`, `${to}^{commit}`]));
  const toDate = (await git(['log', '-1', '--format=%cI', toCommit])).trim();
  const commits = commitsWithFiles(await git(['log', '--no-merges', '--name-only', '--format=%x1e%H%x1f%s', range]));
  const includeLog = patchLog([], ['include/']); // 두 단계가 함께 쓰는 include/ 패치 로그(Promise)
  const [exportsDiff, headers, focus, kconfig, pulls, docs] = await Promise.all([
    collectExports(), collectHeaders(includeLog), collectFocus(includeLog), collectKconfig(), collectPulls(), collectDocs(),
  ]);

  // 지워진 API 를 이전 버전 drivers/·sound/ 의 몇 파일이 썼는지(정의 파일 제외) — 트리 밖 드라이버가 걸릴 가능성의 근사치.
  const apiNames = [...new Set([...exportsDiff.removed, ...headers].map((e) => e.name))];
  const users = await wordFiles(from, apiNames, ['drivers/', 'sound/']);
  for (const e of [...exportsDiff.removed, ...headers]) {
    e.driverUses = [...(users.get(e.name) || [])].filter((f) => f !== e.file).length;
  }

  const campaigns = findCampaigns(commits);
  const broad = broadCommits(commits);
  // AI 가 대체 API·따라 할 일을 커밋 문구에서만 찾도록, 상위 항목의 커밋 메시지를 함께 남긴다.
  const removals = [...exportsDiff.removed, ...headers].filter((e) => e.commit && e.driverUses > 0)
    .sort((a, b) => b.driverUses - a.driverUses).slice(0, 40);
  const focusCommits = focus.flatMap((a) => a.items.filter((i) => i.change !== 'added' && i.commit)
    .sort((x, y) => y.driverUses - x.driverUses).slice(0, 8).map((i) => i.commit.sha));
  const shas = [...new Set([
    ...removals.map((e) => e.commit.sha), ...broad.slice(0, 20).map((c) => c.sha), ...campaigns.slice(0, 12).map((c) => c.commits[0]), ...focusCommits,
  ])];
  const messages = {};
  const log = shas.length ? await git(['log', '--no-walk=unsorted', '--format=%x1e%H%x1f%b', ...shas]) : '';
  for (const block of log.split('\x1e')) {
    const [sha, body] = block.split('\x1f');
    if (body) messages[sha] = body.replace(TRAILER_RE, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
  }

  const data = {
    range: { from, to, fromCommit, toCommit, toDate, commits: commits.length, merges: pulls.length },
    exports: exportsDiff,
    headers,
    focus,
    kconfig,
    campaigns,
    broad,
    docs,
    pulls,
    messages,
  };
  const out = path.join(root, 'data', 'raw', 'driver-impact', `${range}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`[driver-impact] ${range}: ${commits.length} commits, ${pulls.length} pulls, `
    + `exports -${exportsDiff.removed.length}/~${exportsDiff.changed.length}, headers -${headers.length}, `
    + `focus ${focus.map((a) => `${a.id}:${a.items.filter((i) => i.change !== 'added').length}`).join(' ')}, `
    + `kconfig -${kconfig.removed.length}, campaigns ${data.campaigns.length}, broad ${data.broad.length} → ${path.relative(root, out)}`);
}

main().catch((err) => {
  console.error(`[driver-impact] ${err.stack || err.message}`);
  process.exitCode = 1;
});
