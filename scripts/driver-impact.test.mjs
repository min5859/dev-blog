import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areaDefs, broadCommits, buildAiInput, buildPost, cleanNotes, compatibleChange, compileProfile, declaredName, diffExports, diffHeaderApi, exportName, filesByWord,
  findCampaigns, FOCUS_AREAS, headerStatus, ltsPair, memberGreps, memberUsers, mergeHeaderApis, normalizeSubject, parseExports, parseHeaderApi, parseKconfig, parsePull,
  patchLines, pendingTags, postedRanges, relevance, removalCommits, structGrep, defineGrep, fixExamples, impactOf, moduleOf, renamedInExamples, splitAiInput,
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
  // 같은 이름을 스스로 #define 한 드라이버의 사용은 사라진 매크로의 사용이 아니다.
  const own = defineGrep(['PRIV', 'to_dev_attr']);
  assert.equal(own.pattern, '^[[:space:]]*#[[:space:]]*define[[:space:]]+(PRIV|to_dev_attr)\\b');
  const definers = filesByWord(['v1:drivers/gpu/drm/x/x.h:#define PRIV', 'v1:drivers/base/core.c:# define\tto_dev_attr'], own.name);
  assert.deepEqual([[...definers.get('PRIV')], [...definers.get('to_dev_attr')]], [['drivers/gpu/drm/x/x.h'], ['drivers/base/core.c']]);
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
  // 벤더가 정의하고 한 벤더의 미디어 드라이버만 쓰던 것은 그 벤더 안의 연결이다(같은 종류라는 이유로는 세지 않는다)
  const oneVendor = ['drivers/media/platform/vendor/a.c', 'drivers/media/platform/vendor/b.c'];
  assert.equal(relevance({ users: oneVendor, file: 'drivers/soc/vendor/helper.c' }, PROFILE).tier, 'other');
  assert.equal(relevance({ users: oneVendor, file: 'include/soc/vendor/pmc.h' }, PROFILE).tier, 'other');
  assert.equal(relevance({ users: [...oneVendor, 'drivers/media/platform/other/c.c'], file: 'drivers/soc/vendor/helper.c' }, PROFILE).tier, 'mine'); // 두 벤더가 쓴다
  assert.equal(relevance({ users: oneVendor.slice(0, 1), file: 'include/linux/of.h' }, PROFILE).tier, 'mine'); // 코어 헤더의 API 는 한 파일이 써도 센다
  assert.equal(relevance({ users: oneVendor.slice(0, 1), file: 'drivers/iommu/iommu.c' }, PROFILE).tier, 'mine'); // 서브시스템 코어도 마찬가지
  assert.equal(relevance({ users: oneVendor.slice(0, 1), file: 'drivers/media/v4l2-core/v4l2-fh.c' }, PROFILE).tier, 'mine');
  assert.equal(relevance({ users: ['drivers/soc/x/pm.c'], file: 'drivers/clk/x/clk.c' }, PROFILE).tier, 'mine'); // 내 플랫폼 경로는 한 곳이어도 센다
  // 센서 플랫폼 데이터 같은 장치 전용 미디어 헤더도 벤더 코드다. V4L2 코어 헤더는 아니다.
  assert.equal(relevance({ users: ['drivers/media/i2c/lm3560.c'], file: 'include/media/i2c/lm3560.h' }, PROFILE).tier, 'other');
  assert.equal(relevance({ users: ['drivers/media/i2c/lm3560.c'], file: 'include/media/v4l2-subdev.h' }, PROFILE).tier, 'mine');
  assert.deepEqual(areaDefs(PROFILE).map((a) => a.id), [...FOCUS_AREAS.map((a) => a.id), 'soc']);
  const headers = (id) => FOCUS_AREAS.find((a) => a.id === id).headers;
  assert.equal(headers('v4l2').test('include/media/v4l2-subdev.h') && headers('v4l2').test('include/media/videobuf2-core.h'), true);
  for (const legacy of ['include/media/rc-core.h', 'include/media/cec.h', 'include/media/drv-intf/saa7146.h', 'include/media/videobuf2-dvb.h']) {
    assert.equal(headers('media-legacy').test(legacy) && !headers('v4l2').test(legacy), true, legacy);
  }
});

test('modules: a change lands in one table by the header or source it came from', () => {
  const titles = ['include/media/v4l2-subdev.h', 'include/media/videobuf2-core.h', 'include/media/rc-core.h', 'include/linux/dma-buf.h', 'include/linux/mm.h',
    'include/linux/mmc/host.h', 'include/linux/gpio/consumer.h', 'include/linux/spinlock.h', 'include/linux/spi/spi.h', 'include/linux/pm_runtime.h',
    'include/linux/platform_device.h', 'drivers/base/regmap/regmap.c', 'include/linux/phy.h', 'include/linux/phy/phy.h', 'include/linux/soc/samsung/exynos-pmu.h',
    'include/net/atmclip.h', undefined].map((f) => moduleOf(f).title);
  assert.deepEqual(titles, ['V4L2', 'videobuf2', '미디어 기타', 'DMA·dma-buf', '메모리',
    '그 밖의 API', 'GPIO', '락·RCU', 'SPI·I3C', '전원(PM)',
    '디바이스 모델', 'regmap·reset', '그 밖의 API', 'PHY', 'Samsung SoC',
    '그 밖의 API', '그 밖의 API']);
});

test('impact: whether existing code still builds, from the signatures alone', () => {
  const fn = (name, before, after) => ({ kind: 'function', change: 'changed', name, before, after });
  const member = (before, after) => ({ kind: 'member', change: 'changed', name: 's.m', struct: 's', member: 'm', before, after });
  assert.equal(impactOf({ kind: 'function', change: 'removed', name: 'gone' }), 'break');
  assert.equal(impactOf(fn('add', 'void add(struct fh *)', 'void add(struct fh *, struct file *)')), 'break'); // 인자가 늘었다
  assert.equal(impactOf(fn('freq', 's64 freq(struct ctrl *, unsigned int)', 's64 freq(const struct pad *, unsigned int)')), 'break'); // 인자 타입이 바뀌었다
  assert.equal(impactOf(fn('free', 'void free(struct h *)', 'int free(struct h *)')), 'ok'); // 반환값을 안 쓰던 호출은 그대로 빌드된다
  assert.equal(impactOf(fn('check', 'int check(struct a *, u32)', 'bool check(struct a *, u32)')), 'ok');
  assert.equal(impactOf(fn('get', 'int get(void)', 'void get(void)')), 'check'); // 반환값을 쓰던 호출만 깨진다
  assert.equal(impactOf(fn('size', 'unsigned long size(struct page *)', 'unsigned long size(const struct page *)')), 'ok'); // 바깥 const 추가
  assert.equal(impactOf(fn('grp', 'int grp(struct d *, const struct g **)', 'int grp(struct d *, const struct g * const *)')), 'ok');
  assert.equal(impactOf(fn('deep', 'int deep(struct g **)', 'int deep(const struct g **)')), 'break'); // 안쪽 const 는 호출 쪽에서 오류다
  assert.equal(impactOf(fn('smp', 'int smp(int, smp_call_func_t, void *, int)', 'int smp(int, smp_call_func_t, void *, bool)')), 'ok'); // 숫자형끼리는 넘기던 값이 변환된다
  assert.equal(impactOf(fn('ptr', 'int ptr(int *)', 'int ptr(bool *)')), 'break'); // 포인터는 아니다
  assert.equal(impactOf(fn('unc', 'int unc(const struct a *)', 'int unc(struct a *)')), 'check'); // const 가 빠졌다
  assert.equal(impactOf(fn('cb', 'int cb(int (*)(void), int)', 'int cb(int (*)(void), int, int)')), 'break'); // 인자에 함수 포인터가 있어도 인자를 제대로 센다
  assert.equal(impactOf(member('int (*)(struct sd *, struct fmt *)', 'int (*)(struct sd *, const struct ci *, struct fmt *)')), 'break'); // 콜백: 구현 함수의 타입이 맞아야 한다
  assert.equal(impactOf(member('void (*)(struct chip *, int)', 'int (*)(struct chip *, int)')), 'break');
  assert.equal(impactOf(member('u8', 'unsigned long')), 'check');
  assert.equal(impactOf(member('const struct g **', 'const struct g * const *')), 'ok'); // 드라이버가 넣던 배열을 그대로 받는다
  assert.equal(impactOf({ kind: 'macro', change: 'changed', name: 'M', before: '(2)', after: '(1)' }), 'break');
  assert.equal(impactOf({ kind: 'export', change: 'changed', name: 'e', before: 'EXPORT_SYMBOL', after: 'EXPORT_SYMBOL_GPL' }), 'check');
});

test('a rename is read from call-site examples, not from the same-commit hint', () => {
  const ex = (before, after) => ({ file: 'drivers/x/y.c', before: [before], after: [after] });
  assert.equal(renamedInExamples({ name: 'del_timer_sync', examples: [ex('del_timer_sync(&a->t);', 'timer_delete_sync(&a->t);'), ex('del_timer_sync(&b);', 'timer_delete_sync(&b);')] }), 'timer_delete_sync');
  assert.equal(renamedInExamples({ name: 'v4l2_fh_add', examples: [ex('v4l2_fh_add(&ctx->fh);', 'v4l2_fh_add(&ctx->fh, file);')] }), null); // 이름은 그대로고 인자가 늘었다
  assert.equal(renamedInExamples({ name: 'old', examples: [ex('old(a);', 'new1(a);'), ex('old(b);', 'new2(b);')] }), null); // 예마다 다르다
  assert.equal(renamedInExamples({ name: 'fd_prepare_fd', renamedTo: '__FD_PREPARE' }), null); // 같은 커밋이 더한 이름만으로는 대체가 아니다
});

test('AI input: every row of the tables with the commit text that explains it', () => {
  const input = buildAiInput(DATA);
  // old_api 는 drivers/base 의 export 라 디바이스 모델 영역의 변화로 한 번만 나온다
  assert.deepEqual(input.focus.find((f) => f.id === 'device').changes,
    [{ name: 'old_api', kind: 'export', change: 'removed', before: 'EXPORT_SYMBOL_GPL', renamedTo: 'new_api', impact: 'break', commit: 'aaaaaaaaaaaa' }]);
  assert.deepEqual(input.apiRemovals, []); // neigh_thing 은 net 안에서만 쓰던 것이라 표에 오르지 않고, AI 에도 묻지 않는다
  assert.deepEqual(input.pulls.map((p) => p.id), ['eeeeeeeeeeee']);
  assert.deepEqual(input.messages, { aaaaaaaaaaaa: 'base: drop old_api | legacy\n\nUse new_api instead.' }); // 표에 든 행의 커밋 제목·본문만
  assert.equal('reader' in input || JSON.stringify(input).includes('"mine"'), false); // 프로필이 없으면 가까운 항목 표시도 없다
  assert.deepEqual(buildAiInput(DATA, undefined, { messageChars: 0 }).messages, { aaaaaaaaaaaa: 'base: drop old_api | legacy' }); // 본문 예산을 넘기면 제목만
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
});

test('AI input splits into parts when a range has many rows', () => {
  const sha = (i) => String.fromCharCode(103 + i).repeat(40); // g…, h…, …
  const headers = Array.from({ length: 9 }, (_, i) => ({ name: `wide_api_${i}`, kind: 'function', file: 'include/linux/wide.h', driverUses: 6,
    users: SUBSYSTEMS.map((s) => `drivers/${s}/w.c`), commit: { sha: sha(i), subject: `wide: drop ${i}` } }));
  const input = buildAiInput({ ...DATA, headers });
  const names = (p) => [...p.focus.flatMap((f) => f.changes), ...p.apiRemovals].map((c) => c.name);
  const parts = splitAiInput(input, 4);
  assert.deepEqual(parts.map((p) => names(p).length), [4, 4, 2]); // old_api + 9
  assert.deepEqual(parts.flatMap(names).sort(), names(input).sort());
  assert.deepEqual(parts.map((p) => p.pulls.length), [1, 0, 0]); // pull 요약은 첫 조각에만 묻는다
  assert.deepEqual(Object.keys(parts[2].messages).sort(), ['nnnnnnnnnnnn', 'oooooooooooo']); // 조각에 든 행의 커밋 글만
  assert.equal(splitAiInput(input, 40).length, 1);
});

test('AI notes: only sentences the input supports survive', () => {
  const free = { kind: 'function', change: 'changed', name: 'v4l2_free', before: 'void v4l2_free(struct h *)', after: 'int v4l2_free(struct h *)', driverUses: 6,
    users: SUBSYSTEMS.map((s) => `drivers/${s}/c.c`), file: 'include/media/v4l2-ctrls.h', commit: { sha: SHA('4'), subject: 'media: return the handler error' } };
  const setFmt = { kind: 'member', change: 'changed', struct: 'wq_ops', member: 'set_fmt', name: 'wq_ops.set_fmt', before: 'int (*)(int)', after: 'int (*)(int, int)', driverUses: 6,
    users: SUBSYSTEMS.map((s) => `drivers/${s}/c.c`), file: 'include/linux/workqueue.h', commit: null };
  const data = {
    ...DATA,
    exports: { ...DATA.exports, removed: [...DATA.exports.removed,
      { name: 'fd_old', kind: 'EXPORT_SYMBOL', header: 'gone', file: 'fs/file.c', driverUses: 7, users: MANY, commit: { sha: SHA('3'), subject: 'file: simplify', renamedTo: '__FD_INTERNAL' } }] },
    focus: [{ id: 'v4l2', files: 1, items: [free], same: {} },
      { id: 'workqueue', files: 1, items: [setFmt, { ...setFmt, change: 'removed', member: 'old', name: 'wq_ops.old', before: 'u8', after: undefined }], same: { wq_ops: ['get_fmt', 'flags'] } }],
    messages: { ...DATA.messages, [SHA('4')]: 'Callers can now write: return v4l2_free(hdl);' },
  };
  const input = buildAiInput(data);
  assert.equal(input.focus.find((f) => f.id === 'v4l2').changes[0].impact, 'ok');
  const { notes, dropped } = cleanNotes({
    apiNotes: [
      { name: 'old_api', note: '`new_api()`로 바꾼다.' },
      { name: 'ghost', note: '입력에 없는 이름' },
      { name: 'fd_old', note: '`__FD_INTERNAL`로 대체한다.' }, // 이름 변경 후보만 근거로 삼았다
      { name: 'fd_old', note: 'https://example.com 참고' },
      { name: 'fd_old', note: '카메라 동작에 영향을 줄 수 있다.' }, // 입력에 없는 영향
      { name: 'fd_old', note: '메시지에 적힌 대로 정리했다.' }, // 독자가 볼 수 없는 입력을 가리킨다
      { name: 'fd_old', note: 'device mapping은 fl사/eject 경로를 본다.' }, // 깨진 글자
      { name: 'v4l2_free', note: '반환값을 받도록 고친다.' }, // 그대로 빌드되는 변화를 고치라고 썼다
      { name: 'v4l2_free', note: '오류를 받도록 맞춘 뒤 호출부가 값을 볼 수 있게 했다.' }, // 커널 쪽이 한 일을 말한 문장은 남긴다(아래 문장이 덮어쓴다)
      { name: 'v4l2_free', note: '`return v4l2_free(hdl);`로 오류를 바로 돌려줄 수 있다.' },
      { name: 'wq_ops.set_fmt', note: '`get_fmt`·`set_fmt` 콜백에 인자가 늘었다.' }, // get_fmt 는 헤더 비교로 그대로다
      { name: 'wq_ops.old', note: '`old`를 `flags`로 옮겼다.' }, // 지워진 멤버가 옮겨 간 곳으로 그대로인 멤버를 든 것은 괜찮다
    ],
    subsystems: [
      { id: 'eeeeeeeeeeee', points: ['`old_api` 제거', 'x'.repeat(401), '`made_up_api()`로 바뀌었다.', '使用 `old_api`'] },
      { id: 'ffffffffffff', points: ['fs'] },
    ],
  }, input);
  assert.deepEqual([...notes.apiNotes], [['old_api', '`new_api()`로 바꾼다.'], ['v4l2_free', '`return v4l2_free(hdl);`로 오류를 바로 돌려줄 수 있다.'], ['wq_ops.old', '`old`를 `flags`로 옮겼다.']]);
  assert.deepEqual(notes.subsystems.get('eeeeeeeeeeee'), ['`old_api` 제거']);
  assert.equal(notes.subsystems.has('ffffffffffff'), false);
  assert.equal(dropped, 9);
  // 이름만 준 답은 문장 꼴로 바꾸되, 그 이름이 커밋 글에 있어야 한다.
  const bare = cleanNotes({ apiNotes: [{ name: 'old_api', note: 'new_api' }, { name: 'fd_old', note: '__FD_INTERNAL' }] }, input);
  assert.deepEqual([...bare.notes.apiNotes], [['old_api', '대신 쓸 것: `new_api`']]);
  // 예전 필드 이름(replacement)으로 저장된 AI 원본도 읽는다.
  assert.equal(cleanNotes({ apiNotes: [{ name: 'old_api', replacement: '`new_api()`를 쓴다.' }] }, input).notes.apiNotes.get('old_api'), '`new_api()`를 쓴다.');
});

test('post: one table per module; facts, impact and commands from code, AI text only in the last column', () => {
  const input = buildAiInput(DATA);
  const template = buildPost(DATA, input);
  assert.equal(template.id, '2026-10-26-linux-v1.1-rc1-driver-impact');
  assert.equal(template.topic, 'linux-driver-impact');
  assert.equal(template.draftMetadata.ai, false);
  assert.deepEqual(template.sections.map((s) => s.heading), ['디바이스 모델', '참고']);
  assert.equal(template.sections[0].body, [
    '| 영향 | 기존 | 변경 | 주요 설명 |',
    '|---|---|---|---|',
    '| **빌드&nbsp;실패** | <code>old&#95;api</code> export | export 해제 | [base: drop old_api \\| legacy](https://git.kernel.org/torvalds/c/aaaaaaaaaaaa) |', // AI 설명이 없으면 커밋 제목
  ].join('\n'));
  assert.equal(template.headline, 'v1.0 → v1.1-rc1: 빌드 실패 1건, 확인 필요 0건, 그대로 빌드 0건 (디바이스 모델)');
  const ref = template.sections[1].body;
  assert.match(ref, /<details>\n<summary><strong>다른 서브시스템 안에서만 쓰이던 변경 1건<\/strong><\/summary>\n\n\| 이름 \| 모듈 \| 변화 \| 사용 파일 \| 커밋 \|\n\|---\|---\|---\|---:\|---\|\n\| `neigh_thing` \| 그 밖의 API \| export 해제 \| 3 \| — \|/);
  assert.match(ref, /\| `usb_thing` \| EXPORT_SYMBOL \| EXPORT_SYMBOL_NS_GPL\("USB"\) \| drivers\/usb\/x\.c \|/);
  assert.match(ref, /\| `USB_OLD` \| drivers\/usb\/Kconfig \| \[usb: remove old driver\]/);
  assert.match(ref, /\*\*Use devm helper\*\* — 커밋 9개 \(usb, spi, i2c\) \[예시\]/);
  assert.match(ref, /<summary><strong>내 드라이버 점검 명령[^<]*<\/strong><\/summary>\n\n```sh\n# 사라진 API 2개\ngit grep -nwF -f - <<'EOF'\nold_api\nneigh_thing\nEOF\n/);
  assert.match(ref, /# 라이선스·네임스페이스가 바뀐 export 1개\ngit grep -nwF -f - <<'EOF'\nusb_thing\nEOF/);
  assert.match(ref, /\(CONFIG_\)\?\(USB_OLD\)/);
  assert.doesNotMatch(ref, /ARCH_X|now_inline|fix typo/); // 헤더에 inline 으로 남은 export, 드라이버 밖 Kconfig, 오타 수정 문서 커밋은 싣지 않는다
  assert.doesNotMatch(template.sections.map((s) => s.body.replace(/<details>[\s\S]*?<\/details>/g, '')).join('\n'), /니다\./); // 펼쳐진 본문에 설명문을 두지 않는다

  const { notes } = cleanNotes({
    apiNotes: [{ name: 'old_api', note: '쓰는 곳이 줄어 정리했다. `new_api()`로 바꾼다.' }],
    subsystems: [{ id: 'eeeeeeeeeeee', points: ['`old_api` 제거'] }],
  }, input);
  const post = buildPost(DATA, input, notes);
  assert.match(post.sections[0].body, /export 해제 \| 쓰는 곳이 줄어 정리했다\. `new_api\(\)`로 바꾼다\. \[커밋\]\(https:\/\/git\.kernel\.org\/torvalds\/c\/aaaaaaaaaaaa\) \|$/);
  assert.match(post.sections.at(-1).body, /<summary><strong>다른 서브시스템의 메인테이너 요약<\/strong><\/summary>\n\n\*\*USB updates from Greg KH\*\* · \[머지\]\([^)]*\)\n- `old_api` 제거/);
  assert.equal(post.draftMetadata.ai, true);
  assert.equal(post.draftMetadata.counts.explained, 1);
});

test('post with a profile: changed parts in bold, repeated changes in one row, real fixes as examples', () => {
  const cam = ['drivers/media/i2c/cam.c', 'drivers/media/platform/isp.c'];
  const padCommit = { sha: SHA('4'), subject: 'media: v4l2-subdev: add client info to pad ops' };
  const padOps = (member, tail) => ({
    change: 'changed', kind: 'member', struct: 'v4l2_subdev_pad_ops', member, name: `v4l2_subdev_pad_ops.${member}`,
    before: `int (*)(struct v4l2_subdev *, ${tail})`, after: `int (*)(struct v4l2_subdev *, const struct v4l2_subdev_client_info *, ${tail})`,
    driverUses: 3, users: [...cam, 'drivers/staging/x/y.c'], file: 'include/media/v4l2-subdev.h', commit: padCommit,
  });
  const fhAdd = { change: 'changed', kind: 'function', name: 'v4l2_fh_add', before: 'void v4l2_fh_add(struct v4l2_fh *)', after: 'void v4l2_fh_add(struct v4l2_fh *, struct file *)',
    driverUses: 2, users: cam, file: 'include/media/v4l2-fh.h', commit: { sha: SHA('6'), subject: 'media: set private_data in v4l2_fh_add()' },
    examples: [{ file: 'drivers/media/platform/a/a.c', before: ['file->private_data = &ctx->fh;', 'v4l2_fh_add(&ctx->fh);'], after: ['v4l2_fh_add(&ctx->fh, file);'] }] };
  const free = { change: 'changed', kind: 'function', name: 'v4l2_free', before: 'void v4l2_free(struct h *)', after: 'int v4l2_free(struct h *)',
    driverUses: 1, users: cam.slice(0, 1), file: 'include/media/v4l2-ctrls.h', commit: null };
  const delTimer = { change: 'removed', kind: 'function', name: 'del_timer_sync', before: 'int del_timer_sync(struct timer_list *)', driverUses: 2, users: cam, file: 'include/linux/timer.h',
    commit: { sha: SHA('7'), subject: 'treewide: switch to timer_delete_sync()' },
    examples: [{ file: 'drivers/media/i2c/cam.c', before: ['del_timer_sync(&cam->timer);'], after: ['timer_delete_sync(&cam->timer);'] },
      // 선언을 지우고 다른 변수를 더한 hunk 는 예시로 쓰지 않는다
      { file: 'drivers/usb/u.c', before: ['struct timer_list *t = del_timer_sync(x);'], after: ['u32 peak;'] }] };
  // 한 커밋이 지운 60개(드라이버를 통째로 지움)와, 커밋이 다 다른 70개
  const gone = Array.from({ length: 60 }, (_, i) => ({ name: `sgi_api_${i}`, kind: 'EXPORT_SYMBOL_GPL', header: 'gone', file: 'drivers/misc/sgi/x.c', driverUses: 2,
    users: ['drivers/misc/sgi/a.c', 'drivers/misc/sgi/b.c'], commit: { sha: SHA('5'), subject: 'misc: remove SGI driver' } }));
  const lone = Array.from({ length: 70 }, (_, i) => ({ name: `lone_api_${String(i).padStart(2, '0')}`, kind: 'function', file: 'include/linux/lone.h', driverUses: 1,
    users: ['drivers/net/lone.c'], commit: { sha: String(i).padStart(40, 'b'), subject: `net: drop lone ${i}` } }));
  const data = {
    ...DATA,
    exports: { ...DATA.exports, removed: [...DATA.exports.removed, ...gone,
      { name: 'x86_only', kind: 'EXPORT_SYMBOL', header: 'gone', file: 'arch/x86/kernel/x.c', driverUses: 7, users: MANY, commit: null }] },
    headers: [...DATA.headers, ...lone, { name: 'cam_helper', kind: 'function', file: 'include/linux/cam.h', driverUses: 2, users: cam, commit: null }],
    kconfig: { ...DATA.kconfig, removed: [...DATA.kconfig.removed, { name: 'VIDEO_OLD', file: 'drivers/media/platform/Kconfig', commit: null }] },
    focus: [
      { id: 'v4l2', files: 1, items: [padOps('set_fmt', 'struct v4l2_subdev_format *'), padOps('get_selection', 'struct v4l2_subdev_selection *'), fhAdd, free,
        { change: 'added', kind: 'member', name: 'v4l2_subdev_fh.ci', after: 'x', file: 'include/media/v4l2-subdev.h' }], same: { v4l2_subdev_pad_ops: ['get_fmt'] } },
      { id: 'timer', files: 1, items: [delTimer], same: {} },
    ],
    pulls: [...DATA.pulls, { sha: SHA('2'), tag: 'media/v1.1-1', title: 'Pull media updates from Mauro', summary: 'Pad ops take client info.', files: 30, driverFiles: 28 }],
  };
  const input = buildAiInput(data, PROFILE);
  const { notes } = cleanNotes({
    apiNotes: [{ name: 'v4l2_subdev_pad_ops.set_fmt', note: '클라이언트별로 UAPI를 구분하려고 인자를 더했다.' }],
    subsystems: [{ id: '222222222222', points: ['pad ops가 client info를 받는다.'] }],
  }, input);
  const post = buildPost(data, input, notes, { profile: PROFILE });
  assert.deepEqual(post.sections.map((s) => s.heading), ['V4L2', '디바이스 모델', '타이머', '그 밖의 API', 'Kconfig', '참고']);

  const v4l2 = post.sections[0].body;
  const lines = v4l2.split('\n');
  // 같은 커밋에서 같은 인자가 더해진 두 콜백은 한 행. 길어서 그대로인 인자는 … 로 줄이고 더해진 인자만 굵게 쓴다.
  assert.match(lines[2], /^\| \*\*빌드&nbsp;실패\*\* \| <code>v4l2&#95;subdev&#95;pad&#95;ops\.get&#95;selection\(struct v4l2&#95;subdev &#42;, struct v4l2&#95;subdev&#95;selection &#42;\)<\/code><br>외 1개: <code>\.set&#95;fmt<\/code> \| /);
  assert.match(lines[2], / \| <code>v4l2&#95;subdev&#95;pad&#95;ops\.get&#95;selection\(…, <b>const struct v4l2&#95;subdev&#95;client&#95;info &#42;<\/b>, …\)<\/code> \| 클라이언트별로 UAPI를 구분하려고 인자를 더했다\. \[커밋\]\([^)]*444444444444\) \|$/);
  assert.equal(lines[3], '| **빌드&nbsp;실패** | <code>v4l2&#95;fh&#95;add(struct v4l2&#95;fh &#42;)</code> | <code>v4l2&#95;fh&#95;add(struct v4l2&#95;fh &#42;, <b>struct file &#42;</b>)</code> | [media: set private_data in v4l2_fh_add()](https://git.kernel.org/torvalds/c/666666666666) |');
  assert.equal(lines[4], '| 그대로&nbsp;빌드 | <code><b>void</b> v4l2&#95;free(struct h &#42;)</code> | <code><b>int</b> v4l2&#95;free(struct h &#42;)</code> | — |');
  assert.match(v4l2, /<details>\n<summary><strong>고친 예 1건 \(메인라인 드라이버\)<\/strong><\/summary>\n\n`v4l2_fh_add` · drivers\/media\/platform\/a\/a\.c\n\n```diff\n- file->private_data = &ctx->fh;\n- v4l2_fh_add\(&ctx->fh\);\n\+ v4l2_fh_add\(&ctx->fh, file\);\n```\n\n<\/details>$/);

  // 호출부 예시가 모두 같은 이름으로 바꿨으면 변경 칸에 새 이름을 쓴다.
  const timer = post.sections[2].body;
  assert.match(timer, /\| \*\*빌드&nbsp;실패\*\* \| <code>del&#95;timer&#95;sync\(struct timer&#95;list &#42;\)<\/code> \| <code><b>timer&#95;delete&#95;sync<\/b>\(\)<\/code> \| /);
  assert.match(timer, /```diff\n- del_timer_sync\(&cam->timer\);\n\+ timer_delete_sync\(&cam->timer\);\n```/);
  assert.doesNotMatch(timer, /u32 peak/);
  assert.match(post.sections[1].body, /<code>old&#95;api<\/code> export \| export 해제 \|/);
  assert.match(post.sections[3].body, /\| \*\*빌드&nbsp;실패\*\* \| <code>cam&#95;helper\(\)<\/code> \| 삭제 \| — \|/);
  assert.equal(post.sections[4].body.split('\n')[2], '| 확인&nbsp;필요 | <code>CONFIG&#95;VIDEO&#95;OLD</code><br>drivers/media/platform/Kconfig | 삭제 | — |');

  const ref = post.sections[5].body;
  assert.match(ref, /다른 서브시스템 안에서만 쓰이던 변경 132건/); // x86_only + neigh_thing + sgi 60 + lone 70
  assert.match(ref, /\| `x86_only` \| 그 밖의 API \| export 해제 \| 7 \| — \|/); // 다른 아키텍처의 export 는 여러 서브시스템이 써도 접는다
  assert.match(ref, /\| `sgi_api_0`, `sgi_api_1`, `sgi_api_10` 외 57개 \| 그 밖의 API \| export 해제 \| 2 \| \[misc: remove SGI driver\]/);
  assert.match(ref, /사용 수가 적은 나머지 23줄은 뺐습니다\. 이름은 모두 점검 명령에 있습니다\./);
  assert.match(ref, /<summary><strong>API 밖의 변화 \(메인테이너 요약\)<\/strong><\/summary>\n\n\*\*media updates from Mauro\*\* · \[머지\]\([^)]*\)\n- pad ops가 client info를 받는다\./);
  assert.match(ref, /- \*\*V4L2·videobuf2·미디어 컨트롤러\*\* 1개: `v4l2_subdev_fh\.ci`/);
  // 표에서 뺀 이름도 점검 명령에는 모두 있다(예전에는 상위 150개만 넣고 "나머지는 점검 명령에"라고 썼다).
  assert.match(ref, /# 사라진 API 134개\n/); // old_api, neigh_thing, sgi 60, x86_only, lone 70, cam_helper
  for (const name of ['lone_api_69', 'sgi_api_59', 'cam_helper', 'old_api', 'x86_only']) assert.match(ref, new RegExp(`\\n${name}\\n`), name);
  assert.match(ref, /# 중점 영역에서 바뀌거나 사라진 API 3개\ngit grep -nwF -f - <<'EOF'\nv4l2_fh_add\nv4l2_free\ndel_timer_sync\nEOF/);
  assert.match(ref, /# 멤버가 바뀌거나 사라진 구조체 1개\ngit grep -nwF -f - <<'EOF'\nv4l2_subdev_pad_ops\nEOF/);

  assert.equal(post.headline, 'v1.0 → v1.1-rc1: 빌드 실패 5건, 확인 필요 0건, 그대로 빌드 1건 (V4L2, 디바이스 모델, 타이머, 그 밖의 API)');
  assert.deepEqual(post.draftMetadata.counts, { commits: 100, merges: 2, tableRows: 6, breaking: 5, check: 0, compatible: 1, explained: 1, folded: 132,
    removedApis: 135, usedRemovedApis: 134, exportChanges: 1, driverKconfig: 2 });
  assert.equal(post.draftMetadata.profile, 'cam');
  assert.deepEqual(post.sources.map((s) => s.title), ['Pull media updates from Mauro']);
});

test('post: only names the core defines count as widely used; device headers in the main area need users', () => {
  const wide = SUBSYSTEMS.map((s) => `drivers/${s}/w.c`);
  const data = {
    ...DATA,
    // 서브시스템 전용 헤더의 매크로와 벤더 드라이버의 export: 이름이 같은 무관한 코드가 여섯 서브시스템에 있을 뿐이다
    headers: [...DATA.headers, { name: 'PRIV', kind: 'macro', file: 'include/net/atmclip.h', driverUses: 6, users: wide, commit: null },
      { name: 'core_helper', kind: 'function', file: 'include/linux/core.h', driverUses: 6, users: wide, commit: null }],
    exports: { ...DATA.exports, removed: [...DATA.exports.removed,
      { name: 'tegra_power_off', kind: 'EXPORT_SYMBOL', header: 'gone', file: 'drivers/soc/tegra/pmc.c', driverUses: 6, users: wide, commit: null }] },
    focus: [{ id: 'v4l2', files: 2, items: [
      { change: 'removed', kind: 'macro', name: 'LM3560_NAME', before: '', driverUses: 1, users: ['drivers/media/i2c/lm3560.c'], file: 'include/media/i2c/lm3560.h', commit: null },
      { change: 'removed', kind: 'function', name: 'v4l2_gone', before: 'void v4l2_gone(void)', driverUses: 1, users: ['drivers/media/usb/x/y.c'], file: 'include/media/v4l2-common.h', commit: null },
    ], same: {} }],
  };
  const post = buildPost(data, buildAiInput(data, PROFILE), undefined, { profile: PROFILE });
  const open = post.sections.slice(0, -1).map((s) => `${s.heading}\n${s.body}`).join('\n');
  assert.match(open, /core&#95;helper\(\)/);
  assert.match(open, /^V4L2\n[^]*v4l2&#95;gone\(void\)/); // 주 영역의 코어 헤더는 사용처와 관계없이 올린다
  assert.doesNotMatch(open, /PRIV|tegra|LM3560/);
  for (const name of ['PRIV', 'tegra_power_off', 'LM3560_NAME']) assert.match(post.sections.at(-1).body, new RegExp(`\\| \`${name}\` \\|`), name); // 지우지 않고 접는다
});

test('post: a long range gets an index and folds what still builds', () => {
  const wide = SUBSYSTEMS.map((s) => `drivers/${s}/w.c`);
  const fn = (name, file, before, after) => ({ change: 'changed', kind: 'function', name, before, after, driverUses: 6, users: wide, file, commit: null });
  const quiet = Array.from({ length: 31 }, (_, i) => fn(`mm_get_${String(i).padStart(2, '0')}`, 'include/linux/mm.h', `void mm_get_${String(i).padStart(2, '0')}(struct page *)`, `int mm_get_${String(i).padStart(2, '0')}(struct page *)`));
  const broke = (name, file) => fn(name, file, `void ${name}(int)`, `void ${name}(int, int)`);
  const data = { ...DATA, focus: [
    { id: 'mm', files: 1, items: [...quiet, broke('mm_set', 'include/linux/mm.h')], same: {} },
    { id: 'timer', files: 1, items: [broke('timer_x', 'include/linux/timer.h')], same: {} },
    { id: 'irq', files: 1, items: [broke('irq_x', 'include/linux/interrupt.h')], same: {} },
    { id: 'workqueue', files: 1, items: [broke('wq_x', 'include/linux/workqueue.h')], same: {} },
  ] };
  const post = buildPost(data, buildAiInput(data));
  assert.deepEqual(post.sections.map((s) => s.heading), ['한눈에', '메모리', '디바이스 모델', '인터럽트', '타이머', 'workqueue', '참고']);
  assert.equal(post.sections[0].body, ['| 모듈 | 빌드 실패 | 확인 필요 | 그대로 빌드 |', '|---|---:|---:|---:|', '| 메모리 | 1 | · | 31 |', '| 디바이스 모델 | 1 | · | · |',
    '| 인터럽트 | 1 | · | · |', '| 타이머 | 1 | · | · |', '| workqueue | 1 | · | · |'].join('\n'));
  const mm = post.sections[1].body;
  assert.match(mm, /^\| 영향 \| 기존 \| 변경 \| 주요 설명 \|\n\|---\|---\|---\|---\|\n\| \*\*빌드&nbsp;실패\*\* \| <code>mm&#95;set\(int\)<\/code> \| <code>mm&#95;set\(int, <b>int<\/b>\)<\/code> \| — \|\n\n<details>\n<summary><strong>그대로 빌드되는 변경 31건<\/strong><\/summary>\n\n\| 영향 \|/);
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

test('fix examples: the small call-site hunks of the commit that changed the name', () => {
  const diff = [
    'diff --git a/drivers/media/v4l2-core/v4l2-fh.c b/drivers/media/v4l2-core/v4l2-fh.c',
    '--- a/drivers/media/v4l2-core/v4l2-fh.c', '+++ b/drivers/media/v4l2-core/v4l2-fh.c',
    '@@ -30 +30 @@', '-void v4l2_fh_add(struct v4l2_fh *fh)', '+void v4l2_fh_add(struct v4l2_fh *fh, struct file *filp)', // 0열: 정의는 예시가 아니다
    'diff --git a/drivers/media/platform/a/a.c b/drivers/media/platform/a/a.c',
    '--- a/drivers/media/platform/a/a.c', '+++ b/drivers/media/platform/a/a.c',
    '@@ -10 +10 @@ static int a_open(struct file *file)', '-\tv4l2_fh_add(&ctx->fh);', '+\tv4l2_fh_add(&ctx->fh, file);',
    '@@ -90,5 +90,2 @@', '-\tv4l2_fh_add(&x);', '-\ta();', '-\tb();', '-\tc();', '+\td();', // 지운 줄이 넷: 한눈에 볼 예시가 아니다
    'diff --git a/drivers/media/platform/b/b.c b/drivers/media/platform/b/b.c',
    '--- a/drivers/media/platform/b/b.c', '+++ b/drivers/media/platform/b/b.c',
    '@@ -5 +5 @@', '-\tv4l2_fh_add(&b->fh);', '+\tv4l2_fh_add(&b->fh, file);', // 같은 서브시스템의 둘째 예는 필요 없다
    'diff --git a/drivers/usb/gadget/u.c b/drivers/usb/gadget/u.c',
    '--- a/drivers/usb/gadget/u.c', '+++ b/drivers/usb/gadget/u.c',
    '@@ -7 +7 @@', '-\t * v4l2_fh_add() is called later', '+\t * see below', // 주석
    '@@ -9 +9 @@', '-\t\tv4l2_fh_add(&u->fh);', '+\t\tv4l2_fh_add(&u->fh, file);',
    'diff --git a/drivers/old/gone.c b/drivers/old/gone.c', '--- a/drivers/old/gone.c', '+++ /dev/null', '@@ -1 +0,0 @@', '-\tv4l2_fh_add(&g);',
  ].join('\n');
  const found = fixExamples(diff, ['v4l2_fh_add', 'v4l2_fh_del']);
  assert.deepEqual(found.get('v4l2_fh_add'), [
    { file: 'drivers/media/platform/a/a.c', before: ['v4l2_fh_add(&ctx->fh);'], after: ['v4l2_fh_add(&ctx->fh, file);'] },
    { file: 'drivers/usb/gadget/u.c', before: ['v4l2_fh_add(&u->fh);'], after: ['v4l2_fh_add(&u->fh, file);'] },
  ]);
  assert.deepEqual(found.get('v4l2_fh_del'), []);
  // 독자와 가까운 드라이버의 예를 앞에 둔다
  const usbFirst = fixExamples(diff, ['v4l2_fh_add'], { prefer: (f) => f.startsWith('drivers/usb/') }).get('v4l2_fh_add');
  assert.deepEqual(usbFirst.map((e) => e.file), ['drivers/usb/gadget/u.c', 'drivers/media/platform/a/a.c']);
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
  // 같은 타입의 다른 표기(`unsigned` 와 `unsigned int`)는 변화가 아니다
  const spell = (text) => mergeHeaderApis([parseHeaderApi(text, 'include/linux/m.h')]);
  assert.deepEqual(diffHeaderApi(spell('char *parse_args(const char *doing, unsigned num, s16 level);\nstruct k { unsigned flags; };\n'),
    spell('char *parse_args(const char *doing, unsigned int num, s16 level);\nstruct k { unsigned int flags; };\n')), []);
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

