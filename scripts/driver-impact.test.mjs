import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areaDefs, broadCommits, buildAiInput, buildPost, cleanNotes, compatibleChange, compileProfile, declaredName, diffExports, diffHeaderApi, exportName, filesByWord,
  findCampaigns, FOCUS_AREAS, headerStatus, ltsPair, memberGreps, memberUsers, mergeHeaderApis, normalizeSubject, parseExports, parseHeaderApi, parseKconfig, parsePull,
  patchLines, pendingTags, postedRanges, relevance, removalCommits, returnChange, structGrep,
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
    'v1:drivers/cxl/core/port.c:EXPORT_SYMBOL_NS_GPL(cxl_port_x, CXL);',
    // 여러 줄 #define 의 본문: 인자 이름(symbol·f)은 export 가 아니다. 어셈블리의 export 는 `;` 없이 쓴다.
    'v1:drivers/cpufreq/amd-pstate.h:#define EXPORT_SYMBOL_FOR_PSTATE_UT(symbol) \\',
    'v1:drivers/cpufreq/amd-pstate.h:\tEXPORT_SYMBOL_FOR_MODULES(symbol, "amd-pstate-ut")',
    'v1:include/linux/pm.h:\t__EXPORT_SYMBOL(name, license, ns);\t\t\\',
    'v1:lib/kstrtox.c:EXPORT_SYMBOL(f)',
    'v1:scripts/Makefile.build:  EXPORT_SYMBOL(symbol);',
    'v1:arch/arm64/lib/memset.S:\tEXPORT_SYMBOL(memset_asm)',
    'v1:drivers/s390/net/ctcm_mpc.c:\tEXPORT_SYMBOL(ctc_indented);\t/* 들여쓴 진짜 export */',
  ]);
  const after = parseExports([
    'v2:drivers/base/core.c:EXPORT_SYMBOL(dev_kept);',
    'v2:drivers/usb/core/hub.c:EXPORT_SYMBOL_NS_GPL(usb_thing, "USB_CORE");',
    'v2:drivers/base/core.c:EXPORT_SYMBOL_GPL(dev_new);',
    'v2:mm/kasan/shadow.c:EXPORT_SYMBOL(memcpy);',
    'v2:drivers/cxl/core/port.c:EXPORT_SYMBOL_NS_GPL(cxl_port_x, "CXL");', // 6.13 문자열 표기: 변경 아님
    'v2:arch/arm64/lib/memset.S:\tEXPORT_SYMBOL(memset_asm)',
    'v2:drivers/s390/net/ctcm_mpc.c:\tEXPORT_SYMBOL(ctc_indented);',
  ]);
  assert.equal(before.has('sym'), false);
  for (const param of ['symbol', 'name', 'f']) assert.equal(before.has(param), false, param);
  assert.equal(before.has('memset_asm') && before.has('ctc_indented'), true);
  assert.equal(exportName('\tEXPORT_SYMBOL_FOR_MODULES(sym, "ext4-test")', 'fs/ext4/ext4.h'), null);
  const diff = diffExports(before, after);
  assert.deepEqual(diff.removed, [{ name: 'dev_old', kind: 'EXPORT_SYMBOL', file: 'drivers/base/core.c' }]);
  assert.deepEqual(diff.changed.map((c) => [c.name, c.from, c.to]), [['usb_thing', 'EXPORT_SYMBOL', 'EXPORT_SYMBOL_NS_GPL(USB_CORE)']]);
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
  // 사라진 구조체는 타입으로 쓴 파일만 센다: `partition_table` 이라는 변수는 `struct partition_table` 사용이 아니다.
  const grep = structGrep(['partition_table', 'bad name', 'x_ops']);
  assert.equal(grep.pattern, '(struct|union)[[:space:]]+(partition_table|x_ops)\\b');
  const typed = filesByWord(['v1:drivers/block/a.c:struct partition_table', 'v1:drivers/usb/b.c:union  x_ops'], grep.name);
  assert.deepEqual([...typed.get('partition_table')], ['drivers/block/a.c']);
  assert.deepEqual([...typed.get('x_ops')], ['drivers/usb/b.c']);
  assert.equal(structGrep([]).pattern, '');
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
  assert.deepEqual(campaign.dirNames, ['drivers/i2c', 'drivers/iio', 'drivers/mmc', 'drivers/pwm', 'drivers/spi', 'drivers/usb']);
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
  assert.equal(result[0].dirNames.length, 12); // 어느 디렉터리를 건드렸는지 남겨야 프로필로 가를 수 있다
  assert.deepEqual(result[1].dirNames, ['drivers/a']);
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
const SUBSYSTEMS = ['usb', 'spi', 'i2c', 'mmc', 'net', 'gpio'];
const MANY = ['drivers/media/i2c/cam.c', ...SUBSYSTEMS.map((s) => `drivers/${s}/x.c`)]; // 미디어 + 6개 서브시스템이 쓰는 이름
const DATA = {
  schema: 2,
  range: { from: 'v1.0', to: 'v1.1-rc1', toDate: '2026-10-25T14:00:00-07:00', commits: 100, merges: 2 },
  exports: {
    removed: [
      { name: 'old_api', kind: 'EXPORT_SYMBOL_GPL', header: 'gone', file: 'drivers/base/x.c', driverUses: 7, users: MANY, commit: { sha: SHA('a'), subject: 'base: drop old_api | legacy', renamedTo: 'new_api' } },
      { name: 'now_inline', kind: 'EXPORT_SYMBOL', header: 'inline', file: 'drivers/i2c/x.c', driverUses: 90, commit: null },
      { name: 'neigh_thing', kind: 'EXPORT_SYMBOL', header: 'declared', file: 'net/core/x.c', driverUses: 3, users: ['drivers/net/a.c', 'drivers/net/b.c', 'drivers/net/c.c'], commit: null },
    ],
    changed: [{ name: 'usb_thing', from: 'EXPORT_SYMBOL', to: 'EXPORT_SYMBOL_NS_GPL("USB")', file: 'drivers/usb/x.c', driverUses: 1, users: ['drivers/usb/y.c'] }],
    added: 3,
  },
  headers: [{ name: 'unused_macro', kind: 'macro', file: 'include/linux/y.h', driverUses: 0, users: [], commit: null }],
  kconfig: { removed: [{ name: 'USB_OLD', file: 'drivers/usb/Kconfig', commit: { sha: SHA('b'), subject: 'usb: remove old driver' } }, { name: 'ARCH_X', file: 'arch/x/Kconfig', commit: null }], added: 5 },
  campaigns: [{ pattern: 'Use devm helper', count: 9, prefixes: ['usb', 'spi', 'i2c'], commits: [SHA('c')], dirNames: ['drivers/i2c', 'drivers/spi', 'drivers/usb'] }],
  broad: [{ sha: SHA('d'), subject: 'driver core: convert remove()', files: 40, dirs: 30, dirNames: ['drivers/media/i2c', 'drivers/usb/core'] }],
  docs: { deprecated: '', driverApi: [{ sha: SHA('0'), subject: 'docs: driver-api: fix typo in pin-control' }] },
  pulls: [
    { sha: SHA('e'), title: 'Pull USB updates from Greg KH', summary: 'Removed old_api.', files: 10, driverFiles: 9 },
    { sha: SHA('f'), title: 'Pull fs updates', summary: 'VFS only.', files: 50, driverFiles: 0 },
    { sha: SHA('9'), title: 'Pull networking fixes from Jakub', summary: 'Fixes.', files: 80, driverFiles: 70 },
  ],
  messages: { [SHA('a')]: 'Use new_api instead.', [SHA('1')]: 'A commit nothing in the input cites.' },
};
const PROFILE = compileProfile({
  id: 'cam',
  title: '카메라 드라이버',
  reader: '카메라 드라이버 담당자',
  arch: ['arm64'],
  foreignSources: '^drivers/acpi/',
  groups: [
    { id: 'camera', label: '미디어', describe: 'drivers/media의 i2c·platform', proxy: true, paths: '^drivers/media/(?:i2c|platform)/' },
    { id: 'soc', label: '내 SoC', describe: 'drivers/soc/x', paths: '^drivers/soc/x/' },
  ],
  primaryAreas: ['v4l2'],
  pulls: { tags: '^media/', keywords: 'exynos' },
  extraAreas: [{ id: 'soc', title: 'SoC 헤더', headers: '^include/linux/soc/x/', sources: '^drivers/soc/x/', pulls: '^x-' }],
});

test('profile: relevance comes from which in-tree drivers used the name', () => {
  assert.equal(relevance({ users: ['drivers/media/i2c/cam.c', 'drivers/usb/x.c'] }, PROFILE).tier, 'mine');
  assert.deepEqual(relevance({ users: MANY }, PROFILE).groups, [{ id: 'camera', label: '미디어', count: 1 }]);
  assert.equal(relevance({ users: SUBSYSTEMS.map((s) => `drivers/${s}/x.c`) }, PROFILE).tier, 'generic'); // 6개 서브시스템이 쓴다
  assert.equal(relevance({ users: ['drivers/net/a.c', 'drivers/net/b.c'] }, PROFILE).tier, 'other');
  assert.equal(relevance({ users: ['drivers/media/rc/rc-main.c'] }, PROFILE).tier, 'other'); // 프로필 경로 밖의 미디어
  assert.equal(relevance({ users: MANY, file: 'arch/x86/kernel/x.c' }, PROFILE).tier, 'other'); // 다른 아키텍처가 정의한 export
  assert.equal(relevance({ users: MANY, file: 'arch/arm64/kernel/x.c' }, PROFILE).tier, 'mine');
  assert.equal(relevance({ users: MANY, file: 'drivers/acpi/bus.c' }, PROFILE).tier, 'other'); // 이 플랫폼에 없는 펌웨어 인터페이스
  assert.equal(relevance({ users: MANY }, compileProfile()).tier, 'generic'); // 프로필이 없으면 "내 영역"도 없다
  assert.equal(relevance({}, PROFILE).tier, 'other');
  // 다른 벤더 드라이버가 정의하고 미디어 드라이버 파일 하나만 쓰던 export 는 그 드라이버 안의 연결이다
  assert.equal(relevance({ users: ['drivers/media/platform/vendor/a.c'], file: 'drivers/soc/vendor/helper.c' }, PROFILE).tier, 'other');
  assert.equal(relevance({ users: ['drivers/media/platform/vendor/a.c'], file: 'include/linux/of.h' }, PROFILE).tier, 'mine'); // 코어 헤더의 API 는 한 파일이 써도 센다
  assert.equal(relevance({ users: ['drivers/soc/x/pm.c'], file: 'drivers/clk/x/clk.c' }, PROFILE).tier, 'mine'); // 내 플랫폼 경로는 한 파일이어도 센다
  assert.deepEqual(areaDefs(PROFILE).map((a) => a.id), [...FOCUS_AREAS.map((a) => a.id), 'soc']);
  const headers = (id) => FOCUS_AREAS.find((a) => a.id === id).headers;
  assert.equal(headers('v4l2').test('include/media/v4l2-subdev.h') && headers('v4l2').test('include/media/videobuf2-core.h'), true);
  for (const legacy of ['include/media/rc-core.h', 'include/media/cec.h', 'include/media/drv-intf/saa7146.h', 'include/media/videobuf2-dvb.h']) {
    assert.equal(headers('media-legacy').test(legacy) && !headers('v4l2').test(legacy), true, legacy);
  }
});

test('AI input keeps driver pulls and used changes keyed by short ids, each name in one place', () => {
  const input = buildAiInput(DATA);
  assert.deepEqual(input.pulls.map((p) => p.id), ['eeeeeeeeeeee']);
  // old_api 는 drivers/base 의 export 라 디바이스 모델 영역의 변화로 한 번만 나온다
  assert.deepEqual(input.focus.find((f) => f.id === 'device').changes.map((c) => [c.name, c.commit, c.renamedTo]), [['old_api', 'aaaaaaaaaaaa', 'new_api']]);
  assert.deepEqual(input.apiRemovals.map((a) => [a.name, a.commit]), [['neigh_thing', null]]);
  assert.match(input.apiRemovals[0].kind, /선언은 남음/);
  assert.deepEqual(input.conversions.map((c) => c.id), ['dddddddddddd', 'cccccccccccc']);
  assert.deepEqual(input.messages, { aaaaaaaaaaaa: 'base: drop old_api | legacy\n\nUse new_api instead.' }); // 입력에 든 항목의 커밋 제목·본문만
  assert.equal('reader' in input, false);
  assert.equal(JSON.stringify(input).includes('"mine"'), false);
  // 본문 예산을 넘기면 제목만 남는다
  assert.deepEqual(buildAiInput(DATA, undefined, { messageChars: 0 }).messages, { aaaaaaaaaaaa: 'base: drop old_api | legacy' });
});

test('profile: AI input marks what is near the reader and cuts keyword pulls to the matching lines', () => {
  const data = { ...DATA, pulls: [...DATA.pulls,
    { sha: SHA('2'), tag: 'media/v1.1-1', title: 'Pull media updates from Mauro', summary: 'New sensor drivers.', files: 30, driverFiles: 28 },
    { sha: SHA('3'), tag: 'clk-for-linus', title: 'Pull clk updates from Stephen Boyd', summary: 'Core:\n - new helper\n\nDrivers:\n - Exynos990 CMU clocks\n   and more\n - Qualcomm X', files: 20, driverFiles: 18 },
    // 키워드가 소제목에만 있으면 그 아래 목록이 딸려 온다
    { sha: SHA('4'), tag: 'drm-next', title: 'Pull drm updates from Dave Airlie', summary: ' core:\n   - new helper\n exynos:\n   - use atomic helpers\n   - fix vblank\n gma500:\n   - cleanup', files: 20, driverFiles: 17 },
  ] };
  const input = buildAiInput(data, PROFILE);
  assert.equal(input.reader, '카메라 드라이버 담당자');
  assert.deepEqual(input.pulls.filter((p) => p.mine).map((p) => [p.id, p.summary]),
    [['222222222222', 'New sensor drivers.'], ['333333333333', ' - Exynos990 CMU clocks\n   and more'], ['444444444444', ' exynos:\n   - use atomic helpers\n   - fix vblank']]);
  assert.equal(input.focus.find((f) => f.id === 'device').changes[0].mine, true); // old_api 는 drivers/media/i2c 가 썼다
  assert.deepEqual(input.apiRemovals.map((a) => [a.name, a.mine]), [['neigh_thing', undefined]]);
  assert.equal(input.conversions.find((c) => c.id === 'dddddddddddd').mine, true); // 넓은 변경이 drivers/media/i2c 를 건드렸다
  assert.equal(input.conversions.find((c) => c.id === 'cccccccccccc').mine, undefined);
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

  // 프로필이 있으면 "먼저 볼 것"은 독자와 가까운 근거를 든 항목만 남긴다.
  const near = cleanNotes({ overview: [
    { text: '`neigh_thing`은 선언만 남았다.', refs: ['neigh_thing'] },
    { text: '`old_api`가 사라졌다.', refs: ['old_api'] },
  ], subsystems: [] }, buildAiInput(DATA, PROFILE)).notes.overview;
  assert.deepEqual(near.map((o) => o.refs[0]), ['old_api']);

  // 입력에 없는 영향·할 일을 덧붙인 문장과, 이름 변경 후보만 보고 "대체한다"고 쓴 문장은 버린다.
  const hinted = { ...DATA, exports: { ...DATA.exports, removed: [...DATA.exports.removed,
    { name: 'fd_old', kind: 'EXPORT_SYMBOL', header: 'gone', file: 'fs/file.c', driverUses: 2, users: MANY, commit: { sha: SHA('3'), subject: 'file: simplify', renamedTo: '__FD_INTERNAL' } }] } };
  const guarded = cleanNotes({
    overview: [
      { text: '`old_api`가 사라져 카메라 동작에 영향을 줄 수 있다.', refs: ['old_api'] },
      { text: '`old_api` 호출부를 점검한다.', refs: ['old_api'] },
    ],
    apiNotes: [{ name: 'fd_old', replacement: '`__FD_INTERNAL`로 대체한다.' }, { name: 'old_api', replacement: '`new_api()`로 바꾼다.' }],
    conversionNotes: [{ id: 'dddddddddddd', action: '메시지에 적힌 대로 `remove()`를 바꾼다.' }], // 독자가 볼 수 없는 입력을 가리키는 말
    subsystems: [],
  }, buildAiInput(hinted));
  assert.equal(guarded.notes.overview.length, 0);
  assert.deepEqual([...guarded.notes.apiNotes.keys()], ['old_api']); // new_api 는 커밋 본문에 있다
  assert.equal(guarded.notes.conversionNotes.size, 0);
  assert.equal(guarded.dropped, 4);
  // 이름만 준 답은 문장 꼴로 바꾸되, 그 이름이 커밋 글에 있어야 한다(이름 변경 후보만으로는 안 된다).
  const bare = cleanNotes({ overview: [], subsystems: [], apiNotes: [{ name: 'old_api', replacement: 'new_api' }, { name: 'fd_old', replacement: '__FD_INTERNAL' }] }, buildAiInput(hinted));
  assert.deepEqual([...bare.notes.apiNotes], [['old_api', '대신 쓸 것: `new_api`']]);
});

test('post without a profile: widely used APIs open, the rest folded, facts and commands from code', () => {
  const input = buildAiInput(DATA);
  const template = buildPost(DATA, input);
  assert.equal(template.id, '2026-10-26-linux-v1.1-rc1-driver-impact');
  assert.equal(template.topic, 'linux-driver-impact');
  assert.equal(template.draftMetadata.ai, false);
  assert.deepEqual(template.sections.map((s) => s.heading), ['여러 서브시스템이 쓰는 API 변화', '트리 전체 참고', '내 드라이버 점검 명령']);
  const body = Object.fromEntries(template.sections.map((s) => [s.heading, s.body]));
  assert.match(body['여러 서브시스템이 쓰는 API 변화'],
    /- \*\*`old_api`\*\* — export 해제 · 사용 7개 파일 · \[base: drop old_api \\\| legacy\]\(https:\/\/git\.kernel\.org\/torvalds\/c\/aaaaaaaaaaaa\)\n {2}- 이전 `EXPORT_SYMBOL_GPL`\n {2}- 같은 커밋에서 `new_api` 추가\(이름 변경 후보\)/);
  const ref = body['트리 전체 참고'];
  assert.match(ref, /<details>\n<summary><strong>다른 서브시스템 안에서만 쓰이던 API 1개<\/strong><\/summary>\n\n/);
  assert.match(ref, /\| `neigh_thing` \| export 해제\(선언은 남아 링크에서 실패\) \| — \| 3 \| — \|/);
  assert.match(ref, /\| `usb_thing` \| EXPORT_SYMBOL \| EXPORT_SYMBOL_NS_GPL\("USB"\) \| drivers\/usb\/x\.c \|/);
  assert.match(ref, /\| `USB_OLD` \| drivers\/usb\/Kconfig \| — \| \[usb: remove old driver\]/);
  assert.match(ref, /\*\*Use devm helper\*\* — 커밋 9개 \(usb, spi, i2c\)\. \[예시\]/);
  assert.doesNotMatch(ref, /old_api|ARCH_X|now_inline|fix typo/); // 오타 수정 문서 커밋은 싣지 않는다
  const check = body['내 드라이버 점검 명령'];
  assert.match(check, /<details>\n<summary><strong>명령 펼치기<\/strong><\/summary>\n\n```sh\n# 사라진 API 2개\ngit grep -nwF -f - <<'EOF'\nold_api\nneigh_thing\nEOF\n/);
  assert.match(check, /# 라이선스·네임스페이스가 바뀐 export 1개\ngit grep -nwF -f - <<'EOF'\nusb_thing\nEOF/);
  assert.match(check, /\(CONFIG_\)\?\(USB_OLD\)/);
  assert.doesNotMatch(check, /now_inline|ARCH_X/);

  const { notes } = cleanNotes({
    overview: [{ text: '`old_api` 대신 `new_api`.', refs: ['old_api', 'eeeeeeeeeeee'] }],
    apiNotes: [{ name: 'old_api', replacement: '`new_api()`로 바꾼다.' }],
    conversionNotes: [{ id: 'dddddddddddd', action: '`remove()`가 void를 돌려주게 바꾼다.' }],
    subsystems: [{ id: 'eeeeeeeeeeee', points: ['`old_api` 제거'] }],
  }, input);
  const post = buildPost(DATA, input, notes);
  assert.equal(post.sections[0].heading, '먼저 볼 것');
  assert.equal(post.sections[0].body, '- `old_api` 대신 `new_api`.');
  assert.equal(post.headline, '`old_api` 대신 `new_api`.');
  const text = post.sections.map((s) => s.body).join('\n');
  assert.match(text, / {2}- 이전 `EXPORT_SYMBOL_GPL`\n {2}- `new_api\(\)`로 바꾼다\./); // AI 문장이 있으면 이름 변경 후보 대신 쓴다
  assert.match(text, /\*\*USB updates from Greg KH\*\* · \[머지\]\(https:\/\/git\.kernel\.org\/torvalds\/c\/eeeeeeeeeeee\)\n- `old_api` 제거/);
  assert.match(text, /\[driver core: convert remove\(\)\]\([^)]*\) — 드라이버 디렉터리 30곳, 파일 40개\. `remove\(\)`가 void를 돌려주게 바꾼다\./);
  assert.equal(post.draftMetadata.ai, true);
});

test('post with a profile: the reader\'s drivers first, folded tables grouped by commit, a complete check list', () => {
  const padCommit = { sha: SHA('4'), subject: 'media: v4l2-subdev: add client info to pad ops' };
  const cam = ['drivers/media/i2c/cam.c', 'drivers/media/platform/isp.c'];
  const padOps = (member, tail) => ({
    change: 'changed', kind: 'member', struct: 'v4l2_subdev_pad_ops', member, name: `v4l2_subdev_pad_ops.${member}`,
    before: `int (*)(struct v4l2_subdev *, ${tail})`, after: `int (*)(struct v4l2_subdev *, const struct v4l2_subdev_client_info *, ${tail})`,
    driverUses: 3, users: [...cam, 'drivers/staging/x/y.c'], file: 'include/media/v4l2-subdev.h', commit: padCommit,
  });
  // 한 커밋이 지운 60개(드라이버를 통째로 지움)와, 커밋이 다 다른 70개
  const gone = Array.from({ length: 60 }, (_, i) => ({ name: `sgi_api_${i}`, kind: 'EXPORT_SYMBOL_GPL', header: 'gone', file: 'drivers/misc/sgi/x.c', driverUses: 2,
    users: ['drivers/misc/sgi/a.c', 'drivers/misc/sgi/b.c'], commit: { sha: SHA('5'), subject: 'misc: remove SGI driver' } }));
  const lone = Array.from({ length: 70 }, (_, i) => ({ name: `lone_api_${String(i).padStart(2, '0')}`, kind: 'function', file: 'include/linux/lone.h', driverUses: 1,
    users: ['drivers/net/lone.c'], commit: { sha: String(i).padStart(40, 'b'), subject: `net: drop lone ${i}` } }));
  const data = {
    ...DATA,
    exports: { ...DATA.exports, removed: [...DATA.exports.removed, ...gone,
      { name: 'x86_only', kind: 'EXPORT_SYMBOL', header: 'gone', file: 'arch/x86/kernel/x.c', driverUses: 7, users: MANY, commit: null }] },
    headers: [...DATA.headers, ...lone, { name: 'cam_helper', kind: 'function', file: 'include/linux/cam.h', driverUses: 2, users: cam, commit: { sha: SHA('6'), subject: 'cam: drop helper' } }],
    kconfig: { ...DATA.kconfig, removed: [...DATA.kconfig.removed, { name: 'VIDEO_OLD', file: 'drivers/media/platform/Kconfig', commit: null }] },
    focus: [
      { id: 'v4l2', files: 1, items: [padOps('set_fmt', 'struct v4l2_subdev_format *'), padOps('get_selection', 'struct v4l2_subdev_selection *'),
        { change: 'added', kind: 'member', name: 'v4l2_subdev_fh.ci', after: 'x', file: 'include/media/v4l2-subdev.h' }], same: { v4l2_subdev_pad_ops: ['get_fmt'] } },
      { id: 'media-legacy', files: 1, items: [{ change: 'removed', kind: 'member', struct: 'rc_map', member: 'alloc', name: 'rc_map.alloc', before: 'unsigned int',
        driverUses: 2, users: ['drivers/media/rc/keymaps/rc-x.c', 'drivers/media/usb/x/ir.c'], file: 'include/media/rc-map.h', commit: null }], same: {} },
    ],
    pulls: [...DATA.pulls, { sha: SHA('2'), tag: 'media/v1.1-1', title: 'Pull media updates from Mauro', summary: 'Pad ops take client info.', files: 30, driverFiles: 28 }],
  };
  const input = buildAiInput(data, PROFILE);
  const { notes } = cleanNotes({
    overview: [{ text: 'pad ops 콜백에 인자가 늘었다.', refs: ['v4l2_subdev_pad_ops.set_fmt'] }],
    apiNotes: [{ name: 'v4l2_subdev_pad_ops.set_fmt', replacement: '구현에 `const struct v4l2_subdev_client_info *` 인자를 더한다.' }],
    subsystems: [{ id: '222222222222', points: ['pad ops가 client info를 받는다.'] }, { id: 'eeeeeeeeeeee', points: ['`old_api` 제거'] }],
  }, input);
  const post = buildPost(data, input, notes, { profile: PROFILE });
  assert.deepEqual(post.sections.map((s) => s.heading), ['먼저 볼 것', '카메라 드라이버에서 볼 것', '트리 전체 참고', '내 드라이버 점검 명령']);

  const mine = post.sections[1].body;
  assert.match(mine, /### V4L2·videobuf2·미디어 컨트롤러\n\n- \*\*`struct v4l2_subdev_pad_ops`\*\* — 멤버 2개 타입 변경 · 사용 미디어 2 · 전체 3개 파일 · \[media: v4l2-subdev: add client info to pad ops\]\(https:\/\/git\.kernel\.org\/torvalds\/c\/444444444444\)\n {2}- `get_selection`: [^\n]+\n {2}- `set_fmt`: `int \(\*\)\(struct v4l2_subdev \*, struct v4l2_subdev_format \*\)` → `int \(\*\)\(struct v4l2_subdev \*, const struct v4l2_subdev_client_info \*, struct v4l2_subdev_format \*\)`\n {2}- 구현에 `const struct v4l2_subdev_client_info \*` 인자를 더한다\./);
  assert.match(mine, /### 디바이스 모델·PM·펌웨어\n\n- \*\*`old_api`\*\* — export 해제 · 사용 미디어 1 · 전체 7개 파일/);
  assert.match(mine, /### 그 밖에 사라진 API\n\n- \*\*`cam_helper`\*\* — 함수 삭제 · 사용 미디어 2 · 전체 2개 파일 · \[cam: drop helper\]/);
  assert.match(mine, /### 사라진 Kconfig 심볼\n\n- `VIDEO_OLD` \(drivers\/media\/platform\/Kconfig\)/);
  assert.match(mine, /### 함께 볼 전환\n\n[^\n]+\n\n- \[driver core: convert remove\(\)\]\([^)]*\) — 드라이버 디렉터리 30곳\(미디어 1곳\), 파일 40개\./);
  assert.match(mine, /### 메인테이너 요약에서\n\n[^\n]+헤더로 확인한 내용이 아닙니다\.\n\n\*\*media updates from Mauro\*\* · \[머지\]\([^)]*\)\n- pad ops가 client info를 받는다\./);
  assert.doesNotMatch(mine, /rc_map|sgi_api|x86_only|neigh_thing|USB_OLD|lone_api/);

  const ref = post.sections[2].body;
  assert.match(ref, /다른 서브시스템 안에서만 쓰이던 API 133개/); // x86_only + neigh_thing + sgi 60 + rc_map.alloc + lone 70
  assert.match(ref, /\| `x86_only` \| export 해제 \| — \| 7 \|/); // 다른 아키텍처의 export 는 여러 서브시스템이 써도 접는다
  assert.match(ref, /\| `sgi_api_0`, `sgi_api_1`, `sgi_api_10` 외 57개 \| export 해제 \| — \| 2 \| \[misc: remove SGI driver\]/);
  assert.match(ref, /\| `rc_map\.alloc` \| 멤버 삭제 \| `unsigned int` \| 2 \| — \|/); // 프로필 경로 밖(리모컨)은 V4L2 표에 섞이지 않는다
  assert.match(ref, /사용 수가 적은 나머지 24줄은 표에서 뺐습니다\. 이름은 모두 아래 점검 명령에 있습니다\./);
  assert.match(ref, /\*\*USB updates from Greg KH\*\* · \[머지\][^\n]*\n- `old_api` 제거/);
  assert.match(ref, /- \*\*V4L2·videobuf2·미디어 컨트롤러\*\* 1개: `v4l2_subdev_fh\.ci`/);
  assert.doesNotMatch(ref, /media updates from Mauro|VIDEO_OLD|cam_helper/);

  // 표에서 뺀 이름도 점검 명령에는 모두 있다(예전에는 상위 150개만 넣고 "나머지는 점검 명령에"라고 썼다).
  const check = post.sections[3].body;
  assert.match(check, /# 사라진 API 134개\n/);
  for (const name of ['lone_api_69', 'sgi_api_59', 'cam_helper', 'old_api', 'x86_only']) assert.match(check, new RegExp(`\\n${name}\\n`), name);
  assert.match(check, /# 멤버가 바뀌거나 사라진 구조체 2개\ngit grep -nwF -f - <<'EOF'\nv4l2_subdev_pad_ops\nrc_map\nEOF/);
  const shown = `${mine}\n${ref}`;
  for (const name of ['cam_helper', 'neigh_thing', 'x86_only', 'sgi_api_0']) assert.equal(shown.split(`\`${name}\``).length - 1, 1, `${name} appears once`);

  assert.equal(post.draftMetadata.profile, 'cam');
  assert.equal(post.draftMetadata.counts.profileChanges, 4); // pad ops 멤버 2 + old_api + cam_helper
  assert.match(post.summary, /카메라 드라이버에서 볼 API 변경이 4건/);
  assert.deepEqual(post.sources.map((s) => s.title), ['Pull media updates from Mauro']);
});

test('post with a profile: names one commit removed together are one item', () => {
  const drop = { sha: SHA('7'), subject: 'media: i2c: lm3560: drop platform data' };
  const macro = (name) => ({ change: 'removed', kind: 'macro', name, before: '', driverUses: 1, users: ['drivers/media/i2c/lm3560.c'], file: 'include/media/i2c/lm3560.h', commit: drop });
  const data = { ...DATA, focus: [{ id: 'v4l2', files: 1, items: ['LM3560_NAME', 'LM3560_LED0', 'LM3560_LED1', 'LM3560_LED_MAX', 'LM3560_TOUT'].map(macro), same: {} }] };
  const post = buildPost(data, buildAiInput(data, PROFILE), undefined, { profile: PROFILE });
  const mine = post.sections[0].body;
  assert.match(mine, /- \*\*`LM3560_LED_MAX`, `LM3560_LED0`, `LM3560_LED1`, `LM3560_NAME` 외 1개\*\* — 매크로 삭제 5개 · 사용 미디어 1 · 전체 1개 파일 · \[media: i2c: lm3560: drop platform data\]/);
  assert.equal(mine.includes('LM3560_TOUT'), false);
  assert.match(post.sections.at(-1).body, /\nLM3560_TOUT\n/); // 묶여서 이름이 안 보이는 것도 점검 명령에는 있다
});

test('post with a profile: long lists stay in place but fold after the first dozen', () => {
  const headers = Array.from({ length: 15 }, (_, i) => ({ name: `cam_api_${String(i).padStart(2, '0')}`, kind: 'function', file: 'include/linux/cam.h', driverUses: 1, users: ['drivers/media/i2c/cam.c'], commit: null }));
  const data = { ...DATA, headers };
  const post = buildPost(data, buildAiInput(data, PROFILE), undefined, { profile: PROFILE });
  const mine = post.sections.find((s) => s.heading === '카메라 드라이버에서 볼 것').body;
  assert.match(mine, /`cam_api_11`\*\*[^\n]*\n\n<details>\n<summary><strong>그 밖에 사라진 API 나머지 3개<\/strong><\/summary>\n\n- \*\*`cam_api_12`/);
  assert.match(mine, /### V4L2·videobuf2·미디어 컨트롤러\n\n이번 범위에서 이 영역의 헤더는 바뀌지 않았습니다\./); // 주 영역은 변화가 없어도 그렇다고 적는다
  assert.equal(post.headline, 'v1.0 → v1.1-rc1: 카메라 드라이버에서 볼 변경 16건'); // old_api + 15
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
  assert.equal(compatibleChange('randomized_struct_fields_end struct thread_struct', 'struct thread_struct'), true);
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

test('header parser: members wrapped in a macro keep their own types', () => {
  const v1 = 'struct kattr {\n\tssize_t (*show)(struct kobject *kobj, struct kattr *attr, char *buf);\n\tint id;\n\tu8 pad[4];\n};\n';
  // v7.3 kobj_attribute: 기존 타입과 const 타입을 함께 받게 감쌌을 뿐이라 `.show = fn` 은 그대로 빌드된다.
  const v2 = 'struct kattr {\n\t__SYSFS_FUNCTION_ALTERNATIVE(\n\t\tssize_t (*show)(struct kobject *kobj, struct kattr *attr, char *buf);\n'
    + '\t\tssize_t (*show_const)(struct kobject *kobj, const struct kattr *attr, char *buf);\n\t);\n\tstruct_group(hdr,\n\t\tint id;\n\t\tu8 pad[4];\n\t);\n};\n';
  const api = (text) => mergeHeaderApis([parseHeaderApi(text, 'include/linux/k.h')]);
  assert.deepEqual([...api(v2).structs.get('kattr').members.keys()], ['show', 'show_const', 'id', 'pad']);
  assert.deepEqual(diffHeaderApi(api(v1), api(v2)).map((i) => [i.change, i.name]), [['added', 'kattr.show_const']]);
});

test('a function whose return type alone changed is told apart from a signature change', () => {
  const fn = (name, before, after, kind = 'function') => ({ kind, change: 'changed', name, before, after });
  assert.deepEqual(returnChange(fn('v4l2_free', 'void v4l2_free(struct h *)', 'int v4l2_free(struct h *)')), { only: true, callersBuild: true });
  assert.deepEqual(returnChange(fn('i2c_check', 'int i2c_check(struct a *, u32)', 'bool i2c_check(struct a *, u32)')), { only: true, callersBuild: true });
  assert.deepEqual(returnChange(fn('x_get', 'int x_get(void)', 'void x_get(void)')), { only: true, callersBuild: false }); // 반환값을 쓰던 호출은 깨진다
  assert.equal(returnChange(fn('v4l2_add', 'void v4l2_add(struct fh *)', 'void v4l2_add(struct fh *, struct file *)')).only, false);
  assert.equal(returnChange(fn('ops.set', 'void (*)(int)', 'int (*)(int)', 'member')).only, false); // 콜백은 구현을 고쳐야 한다

  const free = { ...fn('v4l2_free', 'void v4l2_free(struct h *)', 'int v4l2_free(struct h *)'), driverUses: 6, users: SUBSYSTEMS.map((s) => `drivers/${s}/c.c`),
    file: 'include/media/v4l2-ctrls.h', commit: { sha: SHA('4'), subject: 'media: return the handler error' } };
  const add = { ...fn('v4l2_add', 'void v4l2_add(struct fh *)', 'void v4l2_add(struct fh *, struct file *)'), driverUses: 6, users: SUBSYSTEMS.map((s) => `drivers/${s}/c.c`),
    file: 'include/media/v4l2-fh.h', commit: null };
  const data = { ...DATA, focus: [{ id: 'v4l2', files: 2, items: [free, add], same: {} }], messages: { [SHA('4')]: 'Callers can now write: return v4l2_free(hdl);' } };
  const input = buildAiInput(data);
  assert.deepEqual(input.focus.find((f) => f.id === 'v4l2').changes.map((c) => [c.name, c.callersBuild]), [['v4l2_add', undefined], ['v4l2_free', true]]);
  const { notes, dropped } = cleanNotes({
    overview: [
      { text: '`v4l2_free()`가 int를 반환하므로 반환값을 받도록 고친다.', refs: ['v4l2_free'] },
      { text: '`v4l2_add()`에 인자가 늘어 호출을 고친다.', refs: ['v4l2_add'] },
    ],
    apiNotes: [{ name: 'v4l2_free', replacement: '`return v4l2_free(hdl);`로 쓸 수 있다.' }, { name: 'v4l2_free', replacement: '호출부를 수정해야 한다.' }],
    subsystems: [],
  }, input);
  assert.deepEqual(notes.overview.map((o) => o.refs[0]), ['v4l2_add']);
  assert.equal(notes.apiNotes.get('v4l2_free'), '`return v4l2_free(hdl);`로 쓸 수 있다.');
  assert.equal(dropped, 2);
  const open = buildPost(data, input, notes).sections.find((s) => s.heading === '여러 서브시스템이 쓰는 API 변화').body;
  assert.match(open, /- \*\*`v4l2_free`\*\* — 반환형 변경 · 사용 6개 파일 · [^\n]+\n {2}- 이전 `void v4l2_free\(struct h \*\)`\n {2}- 이후 `int v4l2_free\(struct h \*\)`\n {2}- 기존 호출은 그대로 빌드된다\.\n {2}- `return v4l2_free\(hdl\);`로 쓸 수 있다\./);
  assert.match(open, /- \*\*`v4l2_add`\*\* — 시그니처 변경 · /);
});

test('focus areas: header changes become blocks with before/after and the AI sentence for that name', () => {
  const wide = SUBSYSTEMS.map((s) => `drivers/${s}/wq.c`);
  const data = {
    ...DATA,
    pulls: [...DATA.pulls, { sha: SHA('7'), tag: 'wq-for-7.4', title: 'Pull workqueue updates from Tejun Heo', summary: 'Per-cpu default.', files: 5, driverFiles: 0 },
      { sha: SHA('8'), tag: 'timers-urgent-2026-11-01', title: 'Pull timer fixes', summary: 'x', files: 2, driverFiles: 0 }],
    headers: [...DATA.headers, { name: 'wq_old', kind: 'function', file: 'include/linux/workqueue.h', driverUses: 6, users: wide, commit: { sha: SHA('5'), subject: 'workqueue: rename', renamedTo: 'wq_new' } }],
    focus: [{ id: 'workqueue', files: 1, items: [
      { change: 'removed', kind: 'function', name: 'wq_old', before: 'void wq_old(void)', driverUses: 6, users: wide, file: 'include/linux/workqueue.h', commit: { sha: SHA('5'), subject: 'workqueue: rename' } },
      { change: 'changed', kind: 'function', name: 'queue_work_on', before: 'bool queue_work_on(int, struct workqueue_struct *, struct work_struct *)',
        after: 'bool queue_work_on(int, struct workqueue_struct *, struct work_struct *, unsigned int)', driverUses: 12, users: [...wide, ...wide.map((f) => f.replace('wq.c', 'wq2.c'))],
        file: 'include/linux/workqueue.h', commit: { sha: SHA('6'), subject: 'workqueue: add flags to queue_work_on()' } },
      { change: 'added', kind: 'function', name: 'queue_work_flags', after: 'bool queue_work_flags(void)', file: 'include/linux/workqueue.h' },
      { change: 'changed', kind: 'member', struct: 'wq_ops', member: 'set_fmt', name: 'wq_ops.set_fmt', before: 'int (*)(int)', after: 'int (*)(int, int)', driverUses: 3,
        users: ['drivers/net/a.c', 'drivers/net/b.c', 'drivers/net/c.c'], file: 'include/linux/workqueue.h', commit: null },
    ], same: { wq_ops: ['get_fmt'] } }],
  };
  const input = buildAiInput(data);
  const wq = input.focus.find((f) => f.id === 'workqueue');
  assert.deepEqual(wq.changes.map((c) => [c.name, c.commit, c.renamedTo]), [['queue_work_on', '666666666666', undefined], ['wq_old', '555555555555', 'wq_new'], ['wq_ops.set_fmt', null, undefined]]);
  assert.deepEqual(wq.pulls, ['777777777777']);
  assert.deepEqual(wq.unchangedMembers, { wq_ops: ['get_fmt'] });
  assert.ok(input.pulls.some((p) => p.id === '777777777777'), 'focus pulls reach the AI even with few driver files');
  assert.deepEqual(input.focus.find((f) => f.id === 'timer').pulls, []); // urgent(fix) pull 은 뺀다
  assert.equal(input.apiRemovals.some((a) => a.name === 'wq_old'), false); // 영역 변화로 이미 나온 이름
  const { notes } = cleanNotes({
    overview: [{ text: '`queue_work_on()`에 인자가 늘었다.', refs: ['queue_work_on'] }],
    subsystems: [],
    apiNotes: [
      { name: 'queue_work_on', replacement: '`queue_work_on()` 호출에 `unsigned int` 인자를 더 넘긴다.' },
      { name: 'wq_ops.set_fmt', replacement: '`get_fmt`·`set_fmt` 콜백에 인자가 늘었다.' }, // get_fmt 는 헤더 비교로 그대로다
      { name: 'wq_old', replacement: '`made_up()`을 쓴다.' },
      { name: 'nope', replacement: 'x' },
    ],
  }, input);
  assert.equal(notes.overview.length, 1);
  assert.deepEqual([...notes.apiNotes], [['queue_work_on', '`queue_work_on()` 호출에 `unsigned int` 인자를 더 넘긴다.']]);

  const post = buildPost(data, input, notes);
  const body = Object.fromEntries(post.sections.map((s) => [s.heading, s.body]));
  const open = body['여러 서브시스템이 쓰는 API 변화'];
  assert.match(open, /헤더를 비교한 영역 \d+개 가운데 v1\.0 드라이버가 쓰던 API가 바뀐 곳은 workqueue 3건, 디바이스 모델·PM·펌웨어 1건입니다\. 바뀐 것이 없는 곳: 메모리·DMA, /);
  assert.match(open, /- \*\*`queue_work_on`\*\* — 시그니처 변경 · 사용 12개 파일 · \[workqueue: add flags to queue_work_on\(\)\]\([^)]*\)\n {2}- 이전 `bool queue_work_on\(int, struct workqueue_struct \*, struct work_struct \*\)`\n {2}- 이후 `bool queue_work_on\(int, struct workqueue_struct \*, struct work_struct \*, unsigned int\)`\n {2}- `queue_work_on\(\)` 호출에 `unsigned int` 인자를 더 넘긴다\./);
  assert.match(open, /- \*\*`wq_old`\*\* — 함수 삭제 · 사용 6개 파일 · \[workqueue: rename\]\([^)]*\)\n {2}- 이전 `void wq_old\(void\)`\n {2}- 같은 커밋에서 `wq_new` 추가\(이름 변경 후보\)/);
  const ref = body['트리 전체 참고'];
  assert.match(ref, /\| `wq_ops\.set_fmt` \| 멤버 타입 변경 \| `int \(\*\)\(int\)` → `int \(\*\)\(int, int\)` \| 3 \| — \|/); // net 안에서만 쓰던 멤버는 접는다
  assert.match(ref, /- \*\*workqueue\*\* 1개: `queue_work_flags`/);
  assert.match(ref, /드라이버를 많이 바꾼 pull 2건[\s\S]*\[USB updates from Greg KH\]\([^)]*\) · \[workqueue updates from Tejun Heo\]\(/); // AI 요약이 없으면 링크만 한 줄
  const check = body['내 드라이버 점검 명령'];
  assert.match(check, /# 중점 영역에서 바뀌거나 사라진 API 1개\ngit grep -nwF -f - <<'EOF'\nqueue_work_on\nEOF/); // wq_old 는 이미 '사라진 API' 목록에 있다
  assert.match(check, /# 멤버가 바뀌거나 사라진 구조체 1개\ngit grep -nwF -f - <<'EOF'\nwq_ops\nEOF/);
  assert.equal(post.draftMetadata.counts.focusChanges, 4);
});
