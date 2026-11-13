import assert from 'node:assert/strict';
import test from 'node:test';
import {
  broadCommits, buildAiInput, buildPost, cleanNotes, compatibleChange, declaredName, diffExports, diffHeaderApi, exportName, filesByWord, findCampaigns,
  headerStatus, ltsPair, memberGreps, memberUsers, mergeHeaderApis, normalizeSubject, parseExports, parseHeaderApi, parseKconfig, parsePull, patchLines,
  pendingTags, postedRanges, removalCommits,
} from './lib/driver-impact.mjs';

test('exports: removed, GPL/namespace changes and macro definitions are told apart', () => {
  const before = parseExports([
    'v1:drivers/base/core.c:EXPORT_SYMBOL(dev_old);',
    'v1:drivers/base/core.c:EXPORT_SYMBOL(dev_kept);',
    'v1:drivers/usb/core/hub.c:EXPORT_SYMBOL(usb_thing);',
    'v1:include/linux/export.h:#define EXPORT_SYMBOL(sym) __EXPORT_SYMBOL(sym, "")',
    'v1:mm/kasan/shadow.c:EXPORT_SYMBOL(memcpy);',
    'v1:mm/kasan/shadow.c:EXPORT_SYMBOL_KASAN(memcpy);',
    'v1:drivers/android/binder.c:EXPORT_SYMBOL_IF_KUNIT(binder_test_only);',
  ]);
  const after = parseExports([
    'v2:drivers/base/core.c:EXPORT_SYMBOL(dev_kept);',
    'v2:drivers/usb/core/hub.c:EXPORT_SYMBOL_NS_GPL(usb_thing, "USB_CORE");',
    'v2:drivers/base/core.c:EXPORT_SYMBOL_GPL(dev_new);',
    'v2:mm/kasan/shadow.c:EXPORT_SYMBOL(memcpy);',
  ]);
  assert.equal(before.has('sym'), false);
  const diff = diffExports(before, after);
  assert.deepEqual(diff.removed, [{ name: 'dev_old', kind: 'EXPORT_SYMBOL', file: 'drivers/base/core.c' }]);
  assert.deepEqual(diff.changed.map((c) => [c.name, c.from, c.to]), [['usb_thing', 'EXPORT_SYMBOL', 'EXPORT_SYMBOL_NS_GPL("USB_CORE")']]);
  assert.equal(diff.added, 1);
});

test('header declarations: top-level functions, macros and structs only', () => {
  assert.deepEqual(declaredName('static inline int dev_foo(struct device *dev)'), { name: 'dev_foo', kind: 'function' });
  assert.deepEqual(declaredName('void __iomem *devm_thing(struct device *dev,'), { name: 'devm_thing', kind: 'function' });
  assert.deepEqual(declaredName('#define SET_SOME_PM_OPS(a, b) \\'), { name: 'SET_SOME_PM_OPS', kind: 'macro' });
  assert.deepEqual(declaredName('struct gpio_legacy {'), { name: 'gpio_legacy', kind: 'struct' });
  for (const body of ['\treturn dev_foo(dev);', 'return bar(x);', '\tint (*probe)(struct device *);', ' * dev_foo() - doc', 'int (*probe)(void);']) {
    assert.equal(declaredName(body), null, body);
  }
});

test('removal commits: latest remover wins and a one-for-one swap is a rename hint', () => {
  const log = [
    '\x1eaaa\x1fgpio: rename gpio_old to gpio_new',
    'diff --git a/include/linux/gpio.h b/include/linux/gpio.h',
    '--- a/include/linux/gpio.h',
    '+++ b/include/linux/gpio.h',
    '@@ -1 +1 @@',
    '-int gpio_old(int x);',
    '+int gpio_new(int x);',
    '\x1ebbb\x1fgpio: drop gpio_old users',
    '--- a/include/linux/gpio.h',
    '+++ b/include/linux/gpio.h',
    '-int gpio_old(int x);',
  ].join('\n');
  const by = removalCommits(patchLines(log), (t) => declaredName(t)?.name || null);
  assert.equal(by.get('gpio_old').sha, 'aaa');
  assert.equal(by.get('gpio_old').renamedTo, 'gpio_new');
  assert.equal(by.get('gpio_old').file, 'include/linux/gpio.h');
  const hunk = [...patchLines('\x1eccc\x1fmedia: add ci\n+++ b/include/media/v4l2-subdev.h\n@@ -10,0 +11 @@ struct v4l2_subdev_pad_ops {\n+\t\t       const struct v4l2_subdev_client_info *ci,')];
  assert.equal(hunk[0].context, 'struct v4l2_subdev_pad_ops {'); // 멤버 이름 줄이 그대로여도 구조체로 커밋을 찾는다
  assert.equal(exportName('EXPORT_SYMBOL_GPL(foo_bar);'), 'foo_bar');
});

test('a removed export left in a header is either still inline or only declared', () => {
  const inline = '/*\n * call i2c_read_block() with either\n--\n#define i2c_read_block(...) __i2c_read_block(__VA_ARGS__)';
  assert.equal(headerStatus('i2c_read_block', inline), 'inline');
  assert.equal(headerStatus('v4l2_fill', 'static inline int\nv4l2_fill(struct x *p)'), 'inline');
  assert.equal(headerStatus('neigh_update', '/* flags for neigh_update() */\n--\nint neigh_update(struct neighbour *n,'), 'declared');
  assert.equal(headerStatus('old_api', ' * old_api() was removed, use new_api()'), 'gone');
  const files = filesByWord(['v1:drivers/a.c:old_api', 'v1:drivers/a.c:old_api', 'v1:sound/b.c:old_api', 'v1:drivers/c.c:other']);
  assert.deepEqual([...files.get('old_api')], ['drivers/a.c', 'sound/b.c']);
});

test('struct members count only files that name the struct and access the member', () => {
  const greps = memberGreps([{ struct: 'module', member: 'args' }, { struct: 'device', member: 'offline' }, { struct: 'bad name', member: 'x' }]);
  assert.equal(greps.typed, 'struct[[:space:]]+(module|device)\\b');
  assert.equal(greps.accessed, '(->|\\.)(args|offline|x)\\b');
  const usersOf = memberUsers(
    ['v1:drivers/a.c:struct module', 'v1:drivers/c.c:struct  device', 'v1:drivers/d.c:struct device'],
    ['v1:drivers/b.c:->args', 'v1:drivers/c.c:->offline', 'v1:drivers/d.c:.offline', 'v1:drivers/d.c:->offline'],
  );
  assert.deepEqual(usersOf('module', 'args'), []); // a.c 는 struct module 만, b.c 는 다른 구조체의 ->args 만
  assert.deepEqual(usersOf('device', 'offline'), ['drivers/c.c', 'drivers/d.c']);
});

test('kconfig symbols keep the path they were declared in', () => {
  const map = parseKconfig(['v1:drivers/usb/Kconfig:config USB_FOO', 'v1:drivers/usb/Kconfig:menuconfig USB_BAR', 'v1:drivers/usb/Kconfig:\tdepends on USB_FOO']);
  assert.deepEqual([...map], [['USB_FOO', 'drivers/usb/Kconfig'], ['USB_BAR', 'drivers/usb/Kconfig']]);
});

test('campaigns need the same change across several subsystems', () => {
  assert.equal(normalizeSubject('usb: gadget: f_fs: Use devm_clk_get_enabled() helper'), 'use devm_clk_get_enabled() helper');
  const commits = ['usb', 'spi', 'i2c', 'iio', 'mmc', 'pwm'].map((p, i) => ({ sha: `s${i}`, subject: `${p}: foo: Use devm_clk_get_enabled() helper`, files: [`drivers/${p}/foo.c`] }));
  const [campaign] = findCampaigns(commits);
  assert.equal(campaign.count, 6);
  assert.equal(campaign.prefixes.length, 6);
  assert.deepEqual(findCampaigns(commits.map((c) => ({ ...c, subject: c.subject.replace(/^\w+/, 'usb') }))), []);
  assert.deepEqual(findCampaigns(commits.map((c) => ({ ...c, subject: c.subject.replace(/Use .*/, 'fix typos in comments') }))), []);
  assert.deepEqual(findCampaigns(commits.map((c) => ({ ...c, files: ['arch/x86/foo.c'] }))), []);
});

test('broad commits count distinct driver directories, treewide always counts', () => {
  const many = Array.from({ length: 12 }, (_, i) => `drivers/x${i}/a.c`);
  const result = broadCommits([
    { sha: 'wide', subject: 'driver core: convert remove()', files: many },
    { sha: 'deep', subject: 'drm/amd: refactor', files: Array.from({ length: 40 }, (_, i) => `drivers/gpu/drm/amd/f${i}.c`) },
    { sha: 'tw', subject: 'treewide: replace foo with bar', files: ['drivers/a/b.c', 'fs/x.c'] },
    { sha: 'typo', subject: 'media: fix typos in comments', files: many },
  ]);
  assert.deepEqual(result.map((c) => c.sha), ['wide', 'tw']);
});

test('pull summaries keep the maintainer text and drop the shortlog', () => {
  const pull = parsePull({
    sha: 'm1',
    subject: "Merge tag 'usb-7.4-rc1' of git://git.kernel.org/pub/scm/linux/kernel/git/gregkh/usb",
    body: "Pull USB updates from Greg KH:\n\n \"Here are the USB changes:\n\n   - removed the old foo API\"\n\n* tag 'usb-7.4-rc1' of git://example:\n  usb: one\n  usb: two\n",
    files: ['drivers/usb/a.c', 'fs/b.c', 'include/linux/usb.h'],
  });
  assert.equal(pull.tag, 'usb-7.4-rc1');
  assert.equal(pull.title, 'Pull USB updates from Greg KH');
  assert.equal(pull.summary, 'Here are the USB changes:\n\n   - removed the old foo API');
  assert.equal(pull.driverFiles, 2);
});

const SHA = (c) => c.repeat(40);
const DATA = {
  range: { from: 'v1.0', to: 'v1.1-rc1', toDate: '2026-10-25T14:00:00-07:00', commits: 100, merges: 2 },
  exports: {
    removed: [
      { name: 'old_api', kind: 'EXPORT_SYMBOL_GPL', header: 'gone', file: 'drivers/base/x.c', driverUses: 7, commit: { sha: SHA('a'), subject: 'base: drop old_api | legacy', renamedTo: 'new_api' } },
      { name: 'now_inline', kind: 'EXPORT_SYMBOL', header: 'inline', file: 'drivers/i2c/x.c', driverUses: 90, commit: null },
      { name: 'neigh_thing', kind: 'EXPORT_SYMBOL', header: 'declared', file: 'net/core/x.c', driverUses: 3, commit: null },
    ],
    changed: [{ name: 'usb_thing', from: 'EXPORT_SYMBOL', to: 'EXPORT_SYMBOL_NS_GPL("USB")', file: 'drivers/usb/x.c' }],
    added: 3,
  },
  headers: [{ name: 'unused_macro', kind: 'macro', file: 'include/linux/y.h', driverUses: 0, commit: null }],
  kconfig: { removed: [{ name: 'USB_OLD', file: 'drivers/usb/Kconfig', commit: { sha: SHA('b'), subject: 'usb: remove old driver' } }, { name: 'ARCH_X', file: 'arch/x/Kconfig', commit: null }], added: 5 },
  campaigns: [{ pattern: 'Use devm helper', count: 9, prefixes: ['usb', 'spi', 'i2c'], commits: [SHA('c')] }],
  broad: [{ sha: SHA('d'), subject: 'driver core: convert remove()', files: 40, dirs: 30 }],
  docs: { deprecated: '', driverApi: [] },
  pulls: [
    { sha: SHA('e'), title: 'Pull USB updates from Greg KH', summary: 'Removed old_api.', files: 10, driverFiles: 9 },
    { sha: SHA('f'), title: 'Pull fs updates', summary: 'VFS only.', files: 50, driverFiles: 0 },
    { sha: SHA('9'), title: 'Pull networking fixes from Jakub', summary: 'Fixes.', files: 80, driverFiles: 70 },
  ],
  messages: { [SHA('a')]: 'Use new_api instead.' },
};

test('AI input keeps driver pulls and used removals, keyed by short ids', () => {
  const input = buildAiInput(DATA);
  assert.deepEqual(input.pulls.map((p) => p.id), ['eeeeeeeeeeee']);
  assert.deepEqual(input.apiRemovals.map((a) => [a.name, a.commit, a.renamedTo]), [['old_api', 'aaaaaaaaaaaa', 'new_api'], ['neigh_thing', null, undefined]]);
  assert.match(input.apiRemovals[1].kind, /선언은 남음/);
  assert.deepEqual(input.conversions.map((c) => c.id), ['dddddddddddd', 'cccccccccccc']);
  assert.equal(input.messages.aaaaaaaaaaaa, 'Use new_api instead.');
});

test('AI notes that cite unknown ids, carry URLs or run long are dropped', () => {
  const input = buildAiInput(DATA);
  const { notes, dropped } = cleanNotes({
    overview: [
      { text: '`old_api`가 사라졌다.', refs: ['old_api', 'eeeeeeeeeeee'] },
      { text: '없는 근거', refs: ['zzzz'] },
      { text: 'https://example.com 참고', refs: ['old_api'] },
    ],
    apiNotes: [{ name: 'old_api', replacement: '`new_api()`를 쓴다.' }, { name: 'ghost', replacement: 'x' }],
    conversionNotes: [{ id: 'dddddddddddd', action: '`remove()`가 void를 돌려주게 바꾼다.' }],
    subsystems: [
      { id: 'eeeeeeeeeeee', points: ['`old_api` 제거', 'x'.repeat(401), '`made_up_api()`로 바뀌었다.', 'device mapping은 fl사/eject 경로를 본다.', '使用 `old_api`'] },
      { id: 'ffffffffffff', points: ['fs'] },
    ],
  }, input);
  assert.equal(notes.overview.length, 1);
  assert.equal(notes.apiNotes.get('old_api'), '`new_api()`를 쓴다.');
  assert.deepEqual(notes.subsystems.get('eeeeeeeeeeee'), ['`old_api` 제거']);
  assert.equal(notes.subsystems.has('ffffffffffff'), false);
  assert.equal(dropped, 4);
});

test('post: facts, grep commands and links come from code; AI text only fills notes', () => {
  const input = buildAiInput(DATA);
  const template = buildPost(DATA, input);
  assert.equal(template.id, '2026-10-26-linux-v1.1-rc1-driver-impact');
  assert.equal(template.topic, 'linux-driver-impact');
  assert.equal(template.draftMetadata.ai, false);
  assert.equal(template.sections.some((s) => s.heading === '먼저 볼 것'), false);
  const body = Object.fromEntries(template.sections.map((s) => [s.heading, s.body]));
  assert.match(body['빌드가 깨질 수 있는 변경'], /\| `old_api` \| export EXPORT_SYMBOL_GPL \| 7 \| `new_api` \(같은 커밋에서 추가\) \| \[base: drop old_api \\\| legacy\]\(https:\/\/git\.kernel\.org\/torvalds\/c\/aaaaaaaaaaaa\) \|/);
  assert.match(body['내 드라이버 점검 명령'], /git grep -nwE 'old_api\|neigh_thing'/);
  assert.doesNotMatch(body['빌드가 깨질 수 있는 변경'] + body['내 드라이버 점검 명령'], /now_inline/);
  assert.match(body['내 드라이버 점검 명령'], /\(CONFIG_\)\?\(USB_OLD\)/);
  assert.doesNotMatch(body['내 드라이버 점검 명령'], /ARCH_X/);

  const { notes } = cleanNotes({
    overview: [{ text: '`old_api` 대신 `new_api`.', refs: ['old_api', 'eeeeeeeeeeee'] }],
    apiNotes: [{ name: 'old_api', replacement: '`new_api()`' }],
    conversionNotes: [],
    subsystems: [{ id: 'eeeeeeeeeeee', points: ['`old_api` 제거'] }],
  }, input);
  const post = buildPost(DATA, input, notes);
  assert.equal(post.sections[0].heading, '먼저 볼 것');
  assert.match(post.sections[0].body, /`old_api`, \[USB updates from Greg KH\]\(https:\/\/git\.kernel\.org\/torvalds\/c\/eeeeeeeeeeee\)/);
  assert.match(post.sections.at(-1).body, /\*\*Pull USB updates from Greg KH\*\* · \[머지\]/);
  assert.equal(post.headline, '`old_api` 대신 `new_api`.');
});

const HEADER_V1 = `/* SPDX */
#ifndef _LINUX_X_H
#define _LINUX_X_H
#define X_FLAG 1
#define x_wrap(a, b) __x_wrap(a, b)
enum x_mode { X_MODE_A, X_MODE_B = 2, };
extern struct workqueue_struct *x_wq;
DEFINE_GUARD(x_lock, struct x_dev *, x_lock(_T), x_unlock(_T))
__printf(2, 3)
int x_log(struct x_dev *dev, const char *fmt, ...);
#ifdef CONFIG_X
void __iomem *x_map(struct device *dev,
                    unsigned int index);
#else
static inline void __iomem *x_map(struct device *d, unsigned int i) { return NULL; }
#endif
static inline int x_count(struct x_dev *dev)
{
	pr_warn("{ not a block;");
	return dev->count;
}
int (*x_hook)(void);
struct x_ops {
	int (*probe)(struct x_dev *dev);
	void (*remove)(struct x_dev *dev);
	union {
		u32 raw;
		struct { u16 lo, hi; };
	};
	unsigned int flags:4;
	DECLARE_BITMAP(caps, 32);
	char name[16];
} __packed;
int x_old(int a);
#endif
`;

test('header parser: prototypes, inline stubs, macros, enums, externs and struct members', () => {
  const { decls, structs } = parseHeaderApi(HEADER_V1, 'include/linux/x.h');
  const sig = (n) => [...decls.get(n).sigs];
  assert.deepEqual(sig('x_map'), ['void *x_map(struct device *, unsigned int)']); // #ifdef 양쪽이 같은 시그니처
  assert.deepEqual(sig('x_log'), ['int x_log(struct x_dev *, const char *, ...)']);
  assert.deepEqual(sig('x_count'), ['int x_count(struct x_dev *)']);
  assert.deepEqual(sig('x_wrap'), ['(2)']);
  assert.equal(decls.get('X_FLAG').kind, 'macro');
  assert.equal(decls.get('X_MODE_B').kind, 'constant');
  assert.deepEqual(sig('x_wq'), ['struct workqueue_struct *']);
  for (const absent of ['DEFINE_GUARD', 'x_hook', 'pr_warn', 'return']) assert.equal(decls.has(absent), false, absent);
  const members = structs.get('x_ops').members;
  assert.deepEqual([...members.keys()], ['probe', 'remove', 'raw', 'lo', 'hi', 'flags', 'caps', 'name']);
  assert.deepEqual([...members.get('probe')], ['int (*)(struct x_dev *)']);
  assert.deepEqual([...members.get('hi')], ['u16']);
  assert.deepEqual([...members.get('flags')], ['unsigned int']);
  assert.deepEqual([...members.get('name')], ['char[]']);
});

test('header diff: signature and callback changes, removals and moves between headers', () => {
  const v2 = HEADER_V1
    .replace('int x_old(int a);\n', '')
    .replace('#define x_wrap(a, b) __x_wrap(a, b)', '#define x_wrap(a) __x_wrap(a)')
    .replace('int (*probe)(struct x_dev *dev);', 'int (*probe)(struct x_dev *dev, const struct x_id *id);')
    .replace('\tvoid (*remove)(struct x_dev *dev);\n', '')
    .replace('int x_log(struct x_dev *dev, const char *fmt, ...);', 'int x_log(struct x_dev *xdev, const char *format, ...);')
    .replace('static inline int x_count(struct x_dev *dev)', 'static inline int x_count(const struct x_dev *dev)');
  const before = mergeHeaderApis([parseHeaderApi(HEADER_V1, 'include/linux/x.h')]);
  // X_FLAG 는 다른 헤더로 옮겨 갔다: 영역 안 이동은 변화가 아니다.
  const after = mergeHeaderApis([parseHeaderApi(v2.replace('#define X_FLAG 1\n', ''), 'include/linux/x.h'), parseHeaderApi('#define X_FLAG 1\nint x_new(void);\n', 'include/linux/x_types.h')]);
  const items = diffHeaderApi(before, after).map((i) => [i.change, i.kind, i.name, i.before ?? null, i.after ?? null]);
  assert.deepEqual(items.filter(([c]) => c !== 'added'), [
    ['changed', 'macro', 'x_wrap', '(2)', '(1)'],
    ['changed', 'function', 'x_count', 'int x_count(struct x_dev *)', 'int x_count(const struct x_dev *)'],
    ['removed', 'function', 'x_old', 'int x_old(int)', null],
    ['changed', 'member', 'x_ops.probe', 'int (*)(struct x_dev *)', 'int (*)(struct x_dev *, const struct x_id *)'],
    ['removed', 'member', 'x_ops.remove', 'void (*)(struct x_dev *)', null],
  ]);
  assert.deepEqual(items.filter(([c]) => c === 'added').map(([, k, n]) => [k, n]), [['function', 'x_new']]);
});

test('header diff: changes callers still compile with are not signature changes', () => {
  const v1 = '#define kzalloc(...) alloc_hooks(kzalloc_noprof(__VA_ARGS__))\n#define x_pr(fmt, ...) pr(fmt)\n'
    + 'extern unsigned long volatile __jiffy_arch_data jiffies;\n__signed_wrap bool x_sub(int i, int *r);\nvoid x_rd(void __iomem *p);\nvoid x_le(__u32 v);\n';
  const v2 = '#define kzalloc(size, flags) alloc_hooks(kzalloc_noprof(size, flags))\n#define x_pr(fmt) pr(fmt)\n'
    + 'extern unsigned long volatile jiffies;\nbool x_sub(int i, int *r);\nvoid x_rd(void *p);\nvoid x_le(__le32 v);\n';
  const items = diffHeaderApi(mergeHeaderApis([parseHeaderApi(v1, 'include/linux/x.h')]), mergeHeaderApis([parseHeaderApi(v2, 'include/linux/x.h')]));
  assert.deepEqual(items.map((i) => [i.change, i.name, i.before, i.after]), [['changed', 'x_le', 'void x_le(__u32)', 'void x_le(__le32)']]);
  assert.equal(compatibleChange('(2)', '(1)'), false);
  assert.equal(compatibleChange('int f(struct x *)', 'int f(const struct x *)'), false);
});

test('new tags: -rc1 and releases after the last note, compared with the previous release', () => {
  const tags = ['v7.2', 'v7.3-rc1', 'v7.3-rc7', 'v7.3', 'v7.4-rc1', 'v7.4-rc2', 'v7.4', 'v7.5-rc1', 'v7.5-rc1-dontuse', 'v2.6.39'];
  assert.deepEqual(pendingTags(tags, ['v7.4-rc1']), [{ from: 'v7.3', to: 'v7.4' }, { from: 'v7.4', to: 'v7.5-rc1' }]);
  assert.deepEqual(pendingTags(tags, ['v7.4-rc1', 'v7.4', 'v7.5-rc1']), []);
  assert.deepEqual(pendingTags(tags, []), [{ from: 'v7.4', to: 'v7.5-rc1' }]);
  assert.deepEqual(pendingTags(['v8.0-rc1'], []), []); // 이전 정식 릴리스가 없으면 비교할 수 없다
});

test('LTS notes: the newest two longterm releases, tracked apart from release notes', () => {
  const releases = [
    { moniker: 'mainline', version: '7.4-rc2' }, { moniker: 'stable', version: '7.3.4' },
    { moniker: 'longterm', version: '6.18.63' }, { moniker: 'longterm', version: '6.12.117' }, { moniker: 'longterm', version: '6.6.162' },
  ];
  const tags = ['v6.6', 'v6.12', 'v6.18', 'v7.3', 'v7.4'];
  assert.deepEqual(ltsPair(releases, tags), { from: 'v6.12', to: 'v6.18' });
  assert.deepEqual(ltsPair([...releases, { moniker: 'longterm', version: '7.4.2' }], tags), { from: 'v6.18', to: 'v7.4' });
  assert.equal(ltsPair(releases.slice(0, 3), tags), null);

  const posted = postedRanges([
    { draftMetadata: { range: 'v7.3..v7.4-rc1' } },
    { draftMetadata: { kind: 'lts', range: 'v6.18..v7.4' } },
    { draftMetadata: {} },
  ]);
  assert.deepEqual(posted.done, ['v7.4-rc1']); // LTS 노트의 끝(v7.4)을 일반 노트가 끝낸 것으로 치지 않는다
  assert.deepEqual([...posted.lts], ['v6.18..v7.4']);
  assert.deepEqual(pendingTags(['v7.3', 'v7.4-rc1', 'v7.4'], posted.done), [{ from: 'v7.3', to: 'v7.4' }]);

  const data = { ...DATA, range: { ...DATA.range, from: 'v1.0', to: 'v1.1' } };
  const post = buildPost(data, buildAiInput(data), undefined, { lts: true });
  assert.equal(post.id, '2026-10-26-linux-v1.0-v1.1-lts-driver-impact');
  assert.equal(post.title, 'Linux 1.0 → 1.1 LTS 드라이버 영향 노트');
  assert.equal(post.draftMetadata.kind, 'lts');
  assert.deepEqual(post.tags.slice(-3), ['LTS', 'v1.0', 'v1.1']);
  assert.equal(buildPost(data, buildAiInput(data)).draftMetadata.kind, undefined);
});

test('focus areas: header changes and area exports become per-area tables with AI points', () => {
  const data = {
    ...DATA,
    pulls: [...DATA.pulls, { sha: SHA('7'), tag: 'wq-for-7.4', title: 'Pull workqueue updates from Tejun Heo', summary: 'Per-cpu default.', files: 5, driverFiles: 0 },
      { sha: SHA('8'), tag: 'timers-urgent-2026-11-01', title: 'Pull timer fixes', summary: 'x', files: 2, driverFiles: 0 }],
    headers: [...DATA.headers, { name: 'wq_old', kind: 'function', file: 'include/linux/workqueue.h', driverUses: 2, commit: { sha: SHA('5'), subject: 'workqueue: rename', renamedTo: 'wq_new' } }],
    focus: [{ id: 'workqueue', files: 1, items: [
      { change: 'removed', kind: 'function', name: 'wq_old', before: 'void wq_old(void)', driverUses: 2, file: 'include/linux/workqueue.h', commit: { sha: SHA('5'), subject: 'workqueue: rename' } },
      { change: 'changed', kind: 'function', name: 'queue_work_on', before: 'bool queue_work_on(int, struct workqueue_struct *, struct work_struct *)',
        after: 'bool queue_work_on(int, struct workqueue_struct *, struct work_struct *, unsigned int)', driverUses: 12, file: 'include/linux/workqueue.h',
        commit: { sha: SHA('6'), subject: 'workqueue: add flags to queue_work_on()' } },
      { change: 'added', kind: 'function', name: 'queue_work_flags', after: 'bool queue_work_flags(void)', file: 'include/linux/workqueue.h' },
      { change: 'changed', kind: 'member', struct: 'wq_ops', member: 'set_fmt', name: 'wq_ops.set_fmt', before: 'int (*)(int)', after: 'int (*)(int, int)', driverUses: 3, file: 'include/linux/workqueue.h', commit: null },
    ], same: { wq_ops: ['get_fmt'] } }],
  };
  const input = buildAiInput(data);
  const wq = input.focus.find((f) => f.id === 'workqueue');
  assert.deepEqual(wq.changes.map((c) => [c.name, c.commit, c.renamedTo]), [['queue_work_on', '666666666666', undefined], ['wq_ops.set_fmt', null, undefined], ['wq_old', '555555555555', 'wq_new']]);
  assert.deepEqual(wq.pulls, ['777777777777']);
  assert.deepEqual(wq.unchangedMembers, { wq_ops: ['get_fmt'] });
  assert.ok(input.pulls.some((p) => p.id === '777777777777'), 'focus pulls reach the AI even with few driver files');
  assert.deepEqual(input.focus.find((f) => f.id === 'timer').pulls, []); // urgent(fix) pull 은 뺀다
  const { notes } = cleanNotes({
    overview: [{ text: '`queue_work_on()`에 인자가 늘었다.', refs: ['queue_work_on'] }],
    subsystems: [],
    focusNotes: [{ id: 'workqueue', points: ['`queue_work_on()` 호출에 `unsigned int` 인자를 더 넘긴다.', '`made_up()`',
      '`get_fmt`·`set_fmt` 콜백에 인자가 늘었다.', '같은 커밋에서 `get_fmt`도 바뀌었다.', '`unchangedMembers`의 멤버는 그대로다.'] }, { id: 'nope', points: ['x'] }],
  }, input);
  assert.equal(notes.overview.length, 1);
  assert.deepEqual([...notes.focus], [['workqueue', ['`queue_work_on()` 호출에 `unsigned int` 인자를 더 넘긴다.']]]);
  const post = buildPost(data, input, notes);
  const focus = post.sections.find((s) => s.heading === '중점 API 영역').body;
  assert.match(focus, /### workqueue\n\n- `queue_work_on\(\)` 호출에/);
  assert.match(focus, /\| 시그니처 변경 \| `queue_work_on` \| `bool queue_work_on\(int, struct workqueue_struct \*, struct work_struct \*\)` → `bool queue_work_on\(.*unsigned int\)` \| 12 \| \[workqueue: add flags/);
  assert.match(focus, /\| 함수 삭제 \| `wq_old` \| `void wq_old\(void\)` → `wq_new` \(같은 커밋에서 추가\) \| 2 \|/);
  assert.match(focus, /새로 생긴 함수·매크로·멤버 1개: `queue_work_flags`/);
  assert.match(focus, /관련 pull: \[workqueue updates from Tejun Heo\]/);
  assert.match(focus, /### 타이머·시간\n\n이번 범위에서 이 영역의 헤더는 바뀌지 않았습니다/);
  assert.match(post.sections.find((s) => s.heading === '내 드라이버 점검 명령').body, /# 중점 영역에서 시그니처가 바뀌거나 사라진 API\ngit grep -nwE 'queue_work_on'\n/); // wq_old 는 이미 '사라진 API' 줄에 있다
  assert.match(focus, /### 디바이스 모델·PM·펌웨어\n\n\| 변화[\s\S]*\| export 해제 \| `old_api` \| `EXPORT_SYMBOL_GPL` → `new_api` \(같은 커밋에서 추가\) \| 7 \|/); // 영역 소스의 export 해제
  assert.equal(post.draftMetadata.counts.focusChanges, 4);
});
