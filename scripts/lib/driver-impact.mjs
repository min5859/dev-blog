// 커널 버전별 드라이버 영향 노트의 순수 함수. git 출력 텍스트만 다루고 네트워크·파일은 쓰지 않는다.

const EXPORT_RE = /\b(EXPORT_SYMBOL\w*)\s*\(\s*([A-Za-z_]\w*)\s*(?:,\s*([^)]*?)\s*)?\)/;
const KCONFIG_RE = /^\s*(?:menu)?config\s+([A-Z0-9_]+)\b/;
const MACRO_RE = /^#\s*define\s+([A-Za-z_]\w*)\(/;
const STRUCT_RE = /^struct\s+([a-z_]\w*)\s*\{/;
// 헤더 최상위(0열) 함수 선언·정의만 본다. 들여쓴 줄은 함수 본문이나 구조체 멤버다.
const FUNC_RE = /^(?!(?:return|if|else|while|for|switch|do|case|goto|sizeof|typedef)\b)[A-Za-z_][\w\s*]*?[\s*]([a-z_][a-z0-9_]*)\s*\(/;
const DRIVER_PATH_RE = /^(?:drivers|sound)\//;
const PULL_DRIVER_PATH_RE = /^(?:drivers\/|sound\/|include\/(?:linux|dt-bindings|sound|media|drm|net)\/|Documentation\/(?:devicetree|driver-api)\/)/;

/** `git grep <tag>` 한 줄 "tag:path:text" → [path, text]. */
export function splitGrepLine(line) {
  const rest = line.slice(line.indexOf(':') + 1);
  const at = rest.indexOf(':');
  return [rest.slice(0, at), rest.slice(at + 1)];
}

/**
 * export 문장인지. `#define` 줄과, C 소스에서 `;` 로 끝나지 않는 줄은 매크로 본문이다: 여러 줄 `#define` 의 둘째 줄
 * `EXPORT_SYMBOL_FOR_MODULES(symbol, "amd-pstate-ut")` 의 `symbol` 은 인자 이름인데 export 로 잡혔다(v7.1·v7.2 `sym`, v7.3 `symbol`).
 * 어셈블리(.S)의 export 는 `;` 없이 쓰므로 그대로 받고, 그 밖의 파일(Makefile 의 sed 문구 등)은 export 가 아니다.
 * file 을 모르면(패치 줄만 볼 때) `#define` 만 거른다.
 */
function isExportStatement(text, file = '') {
  if (/^\s*#\s*define\b/.test(text)) return false;
  if (!file || file.endsWith('.S')) return true;
  return /\.[ch]$/.test(file) && /;\s*(?:\/\*.*\*\/\s*|\/\/.*)?$/.test(text.trimEnd());
}

/** `git grep <tag>` 줄들 → Map(name → { kinds: Set, file }). kind 는 매크로 이름과 네임스페이스 등 추가 인자. */
export function parseExports(lines) {
  const map = new Map();
  for (const line of lines) {
    const [file, text] = splitGrepLine(line);
    if (!isExportStatement(text, file)) continue;
    const m = EXPORT_RE.exec(text);
    if (!m) continue;
    // 6.13 부터 네임스페이스는 문자열(`NS(CXL)` → `NS("CXL")`)이다. 표기만 바뀐 것을 심볼마다 변경으로 세지 않는다.
    // 전환 자체는 그 커밋이 넓은 범위 변경으로 잡힌다.
    const kind = m[3] ? `${m[1]}(${m[3].replace(/^"(.*)"$/, '$1')})` : m[1];
    const entry = map.get(m[2]) || { kinds: new Set(), file };
    entry.kinds.add(kind);
    map.set(m[2], entry);
  }
  return map;
}

export function exportName(text, file = '') {
  return isExportStatement(text, file) ? EXPORT_RE.exec(text)?.[2] || null : null;
}

export function kconfigName(text) {
  return KCONFIG_RE.exec(text)?.[1] || null;
}

// KASAN·KUnit 전용 export 변형은 모듈 드라이버가 쓰는 export 가 아니다.
const moduleKinds = (entry) => [...(entry?.kinds || [])].filter((k) => !/KASAN|IF_KUNIT/.test(k)).sort().join(', ');

export function diffExports(before, after) {
  const removed = [];
  const changed = [];
  for (const [name, old] of before) {
    const from = moduleKinds(old);
    const to = moduleKinds(after.get(name));
    if (!from || from === to) continue;
    if (!after.has(name)) removed.push({ name, kind: from, file: old.file });
    else if (to) changed.push({ name, from, to, file: after.get(name).file });
  }
  const added = [...after.keys()].filter((name) => !before.has(name)).length;
  return { removed, changed, added };
}

/** Kconfig `git grep <tag>` 줄들 → Map(symbol → path). */
export function parseKconfig(lines) {
  const map = new Map();
  for (const line of lines) {
    const [file, text] = splitGrepLine(line);
    const m = KCONFIG_RE.exec(text);
    if (m && !map.has(m[1])) map.set(m[1], file);
  }
  return map;
}

/** 헤더 한 줄이 함수·매크로·구조체를 선언하면 { name, kind }. */
export function declaredName(line) {
  let m = MACRO_RE.exec(line);
  if (m) return { name: m[1], kind: 'macro' };
  m = STRUCT_RE.exec(line);
  if (m) return { name: m[1], kind: 'struct' };
  m = FUNC_RE.exec(line);
  if (m) return { name: m[1], kind: 'function' };
  return null;
}

/**
 * `git log -p -U0 --format=%x1e%H%x1f%s` 출력 → 바뀐 줄마다 { sha, subject, file, sign, text, context }.
 * context 는 hunk 머리의 둘러싼 줄(구조체·함수 선언)이다. 최신 커밋이 먼저 나온다.
 */
export function* patchLines(text) {
  for (const block of text.split('\x1e')) {
    if (!block.trim()) continue;
    const nl = block.indexOf('\n');
    const [sha, subject] = block.slice(0, nl < 0 ? block.length : nl).split('\x1f');
    let file = '';
    let context = '';
    for (const line of block.slice(nl + 1).split('\n')) {
      if (line.startsWith('--- a/')) file = line.slice(6);
      else if (line.startsWith('+++ b/')) file = line.slice(6);
      else if (line.startsWith('@@')) context = line.replace(/^@@[^@]*@@ ?/, '');
      else if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
      else if (line[0] === '-' || line[0] === '+') yield { sha, subject, file, sign: line[0], text: line.slice(1), context };
    }
  }
}

/**
 * 범위 안에서 지워진 이름마다 가장 최근에 지운 커밋. 같은 커밋이 더한 이름은 이름 변경 후보로 붙인다.
 * pick(text, file) → name|null.
 */
export function removalCommits(lines, pick) {
  const removedBy = new Map();
  const addedIn = new Map();
  for (const { sha, subject, file, sign, text } of lines) {
    const name = pick(text, file);
    if (!name) continue;
    if (sign === '+') {
      if (!addedIn.has(sha)) addedIn.set(sha, new Set());
      addedIn.get(sha).add(name);
    } else if (!removedBy.has(name)) {
      removedBy.set(name, { sha, subject, file, text });
    }
  }
  for (const [name, hit] of removedBy) {
    const added = [...(addedIn.get(hit.sha) || [])].filter((other) => other !== name && !removedBy.has(other));
    if (added.length === 1) hit.renamedTo = added[0];
  }
  return removedBy;
}

/** 반복 전환 패턴용: "usb: gadget: foo: Use bar()" → "use bar()". */
export function normalizeSubject(subject) {
  return subject.replace(/^(?:[\w.,/+\- ]{1,40}:\s+)+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 같은 일을 여러 서브시스템에서 반복한 커밋 묶음. */
const NOT_API_CHANGE_RE = /typo|spelling|comment|whitespace|coding style|kernel-doc|dt schema|maintainers|copyright|spdx/i;

export function findCampaigns(commits, { minCount = 6, minPrefixes = 3 } = {}) {
  const groups = new Map();
  for (const c of commits) {
    const key = normalizeSubject(c.subject);
    if (key.length < 12 || NOT_API_CHANGE_RE.test(key) || !(c.files || []).some((f) => DRIVER_PATH_RE.test(f))) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.values()]
    .map((list) => ({
      pattern: list[list.length - 1].subject.replace(/^(?:[\w.,/+\- ]{1,40}:\s+)+/, ''),
      count: list.length,
      prefixes: [...new Set(list.map((c) => c.subject.split(':')[0].trim()))],
      commits: list.map((c) => c.sha),
      dirNames: driverDirs(list.flatMap((c) => c.files || [])),
    }))
    .filter((g) => g.count >= minCount && g.prefixes.length >= minPrefixes)
    .sort((a, b) => b.count - a.count);
}

/** 파일 목록에서 드라이버 디렉터리(깊이 4까지)만 뽑는다. 프로필이 "내 영역을 건드렸는가"를 보는 데 쓴다. */
function driverDirs(files) {
  return [...new Set(files.filter((f) => DRIVER_PATH_RE.test(f)).map((f) => f.split('/').slice(0, -1).slice(0, 4).join('/')))].sort();
}

/** 드라이버 디렉터리를 넓게 건드린 커밋(트리 전체 전환·API 일괄 변경 후보). */
export function broadCommits(commits, { minDirs = 10 } = {}) {
  return commits
    .map((c) => {
      const dirNames = driverDirs(c.files);
      return { sha: c.sha, subject: c.subject, files: c.files.filter((f) => DRIVER_PATH_RE.test(f)).length, dirs: dirNames.length, dirNames };
    })
    .filter((c) => !NOT_API_CHANGE_RE.test(normalizeSubject(c.subject)))
    .filter((c) => c.dirs >= minDirs || (/^treewide:/i.test(c.subject) && c.files > 0))
    .sort((a, b) => b.dirs - a.dirs || b.files - a.files);
}

/** Linus 머지 커밋 → 서브시스템 pull 요약. 메인테이너 요약만 남기고 뒤의 shortlog 는 자른다. */
export function parsePull({ sha, subject, body, files }) {
  const tag = /^Merge (?:tag|branch) '([^']+)'/.exec(subject)?.[1] || '';
  const lines = body.split('\n');
  const title = (lines.find((l) => /^Pull\b/.test(l)) || subject).replace(/:\s*$/, '');
  const cut = body.search(/\n\* (?:tag |branch )?'[^']+'/);
  const summary = (cut < 0 ? body : body.slice(0, cut))
    .split('\n').filter((l) => !/^Pull\b/.test(l)).join('\n')
    .replace(/^\s*"|"\s*$/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return {
    sha, tag, title, summary,
    files: files.length,
    driverFiles: files.filter((f) => PULL_DRIVER_PATH_RE.test(f)).length,
  };
}

/** `git grep -o -w -F <tag>` 출력("tag:path:name") → Map(name → Set(path)). */
export function filesByWord(lines, normalize = (w) => w) {
  const map = new Map();
  for (const line of lines) {
    const [file, raw] = splitGrepLine(line);
    const word = raw && normalize(raw);
    if (!word) continue;
    if (!map.has(word)) map.set(word, new Set());
    map.get(word).add(file);
  }
  return map;
}

/** 구조체 멤버를 쓰는 파일을 찾는 `git grep -o -E` 패턴. 이름은 식별자만 받는다. */
export function memberGreps(items) {
  const alt = (names) => [...new Set(names)].filter((n) => /^\w+$/.test(n)).join('|');
  return { typed: `struct[[:space:]]+(${alt(items.map((i) => i.struct))})\\b`, accessed: `(->|\\.)(${alt(items.map((i) => i.member))})\\b` };
}

/**
 * 구조체·공용체 이름을 타입으로 쓴 파일을 찾는 `git grep -o -E` 패턴과, 그 출력("struct  name")에서 이름을 꺼내는 함수.
 * 이름만 맞추면 흔한 이름이 무관한 변수까지 잡힌다(v7.3 EFS 삭제로 사라진 `struct partition_table` 이 드라이버 3곳 "사용"으로 나왔다).
 */
export function structGrep(names) {
  const alt = [...new Set(names)].filter((n) => /^\w+$/.test(n)).join('|');
  return { pattern: alt ? `(struct|union)[[:space:]]+(${alt})\\b` : '', name: (hit) => hit.replace(/^(?:struct|union)\s+/, '') };
}

/**
 * memberGreps 출력 → (struct, member) 를 쓰는 파일 목록. `struct <이름>`이 나오고 `->멤버`·`.멤버`로 접근하는 파일이다.
 * 이름만 맞추면 args·flags 같은 흔한 멤버가 다른 구조체 것까지 잡혀 수백 배 부푼다(v7.3 module.args 811, 실제 0).
 * 타입은 확인하지 않으므로 여전히 상한이다.
 */
export function memberUsers(typedLines, accessedLines) {
  const typed = filesByWord(typedLines, (w) => w.replace(/^struct\s+/, ''));
  const accessed = filesByWord(accessedLines, (w) => w.replace(/^(?:->|\.)/, ''));
  return (struct, member) => [...(accessed.get(member) || [])].filter((f) => typed.get(struct)?.has(f));
}

/**
 * export 가 사라진 이름이 새 헤더에 어떻게 남았는지(`git grep -h -B1 -w` 출력).
 * inline: 매크로·static inline 으로 남아 소스는 그대로 빌드된다.
 * declared: 선언만 남아 모듈에서 쓰면 링크(modpost) 단계에서 깨진다.
 * gone: 주석에만 남았거나 없다.
 */
export function headerStatus(name, grepText) {
  const macro = new RegExp(`^#\\s*define\\s+${name}\\b`);
  const call = new RegExp(`\\b${name}\\s*\\(`);
  let status = 'gone';
  for (const group of grepText.split(/^--$/m)) {
    const lines = group.split('\n');
    for (const [i, line] of lines.entries()) {
      if (macro.test(line)) return 'inline';
      if (!call.test(line) || /^\s*(?:\*|\/\*|\/\/)/.test(line)) continue;
      if (/\bstatic\s+(?:inline|__always_inline)\b/.test(`${lines[i - 1] || ''} ${line}`)) return 'inline';
      status = 'declared';
    }
  }
  return status;
}

// ── 중점 API 영역: 헤더를 두 태그에서 파싱해 비교 ────────────────────────────

const linuxH = (names) => new RegExp(`^include/linux/(?:${names})\\.h$`);
const NEVER = /(?!)/;
// include/media 가운데 카메라·코덱 드라이버와 무관한 리모컨·CEC·DVB·튜너 헤더. V4L2 영역 표에 섞이면 읽을 것이 흐려진다.
const MEDIA_LEGACY = 'rc-|cec|dvb|dmxdev|demux|tuner|tveeprom|videobuf2-dvb|drv-intf\\/';
/**
 * 드라이버가 많이 쓰는 영역. headers: 비교할 헤더, sources: export 가 있는 소스, pulls: pull 태그.
 * 시그니처·멤버 변화는 여기 든 헤더에서만 잡힌다(삭제된 이름은 트리 전체에서 따로 잡는다).
 */
export const FOCUS_AREAS = [
  { id: 'mm', title: '메모리·DMA',
    headers: linuxH('mm|mm_types|gfp|gfp_types|slab|vmalloc|highmem|highmem-internal|mmzone|page-flags|page_ref|memremap|mempool|mmap_lock|huge_mm|io-mapping|uaccess|dma-mapping|dma-direction|dmapool|scatterlist|dma-buf|dma-fence|dma-resv|dma-heap|cma'),
    sources: /^(?:mm\/|kernel\/dma\/|lib\/scatterlist\.c$|drivers\/dma-buf\/)/,
    pulls: /^(?:mm-(?:stable|core)|slab-|dma-mapping-|memblock-)/ },
  { id: 'v4l2', title: 'V4L2·videobuf2·미디어 컨트롤러',
    headers: new RegExp(`^include/media/(?!(?:${MEDIA_LEGACY}))`),
    sources: /^drivers\/media\/(?:v4l2-core|common\/videobuf2|mc)\//,
    pulls: /^media\// },
  { id: 'media-legacy', title: '리모컨·CEC·DVB·튜너',
    headers: new RegExp(`^include/media/(?:${MEDIA_LEGACY})`),
    sources: /^drivers\/media\/(?:rc|cec\/core|dvb-core|tuners)\//,
    pulls: NEVER },
  { id: 'timer', title: '타이머·시간',
    headers: linuxH('timer|timer_types|hrtimer|hrtimer_types|hrtimer_defs|jiffies|ktime|timekeeping|delay|clockchips|clocksource|time64|alarmtimer'),
    sources: /^kernel\/time\//,
    pulls: /^timers-(?:core|nohz|clocksource)/ },
  { id: 'workqueue', title: 'workqueue',
    headers: linuxH('workqueue|workqueue_types'),
    sources: /^kernel\/workqueue\.c$/,
    pulls: /^wq-/ },
  { id: 'sched', title: '스케줄러·kthread·대기',
    headers: linuxH('sched|sched/[\\w-]+|kthread|wait|wait_bit|swait|completion|preempt|smp|cpumask'),
    sources: /^kernel\/(?:sched\/|kthread\.c$|smp\.c$)/,
    pulls: /^(?:sched-core|kthread)/ },
  { id: 'irq', title: '인터럽트',
    headers: linuxH('interrupt|irq|irqdomain|irqdesc|irqreturn|irqflags|irq_work|msi|irqchip'),
    sources: /^kernel\/irq\//,
    pulls: /^irq-(?:core|drivers)/ },
  { id: 'locking', title: '락·RCU·cleanup',
    headers: linuxH('mutex|mutex_types|spinlock|spinlock_types|rwlock|rwsem|rcupdate|rcupdate_wait|rculist|srcu|srcutree|seqlock|refcount|kref|lockdep|cleanup|local_lock|llist'),
    sources: /^kernel\/(?:locking|rcu)\//,
    pulls: /^(?:locking-core|rcu\.)/ },
  { id: 'device', title: '디바이스 모델·PM·펌웨어',
    headers: linuxH('device|device/[\\w-]+|platform_device|property|fwnode|of|of_\\w+|pm|pm_runtime|pm_wakeup|firmware|devm-helpers|mod_devicetable|module|moduleparam|kobject|sysfs'),
    sources: /^drivers\/(?:base|of)\//,
    pulls: /^(?:driver-core-|pm-\d|devicetree-|modules-)/ },
  { id: 'hw', title: 'clk·GPIO·regulator·regmap·reset·pinctrl',
    headers: linuxH('clk|clk-provider|gpio/consumer|gpio/driver|regulator/consumer|regulator/driver|regmap|reset|reset-controller|pinctrl/[\\w-]+'),
    sources: /^drivers\/(?:clk\/clk\.c$|gpio\/gpiolib|regulator\/core\.c$|base\/regmap\/|reset\/core\.c$|pinctrl\/core\.c$)/,
    pulls: /^(?:clk-for|gpio-updates|regulator-v|regmap-v|reset-|pinctrl-v)/ },
  // 아래 네 영역은 LTS 구간에서 시그니처·멤버 변경이 10건 안팎씩 있었는데 보지 않던 헤더다(v6.6..v6.12 i2c·spi 10, iommu 12, 전원 13, phy 4).
  { id: 'bus', title: 'I2C·SPI·I3C',
    headers: linuxH('i2c|i2c-smbus|i2c-mux|i2c-atr|i2c-algo-bit|spi/spi|spi/spi-mem|i3c/device|i3c/master'),
    sources: /^drivers\/(?:i2c\/i2c-(?:core-\w+|mux|atr|smbus)\.c$|spi\/spi(?:-mem)?\.c$|i3c\/(?:device|master)\.c$)/,
    pulls: /^(?:i2c-for-|spi-v|i3c\/for-)/ },
  { id: 'iommu', title: 'IOMMU·IOVA',
    headers: linuxH('iommu|iova|io-pgtable|dma-map-ops|iommu-dma'),
    sources: /^drivers\/iommu\/(?:iommu|dma-iommu|iova|io-pgtable[\w-]*|of_iommu)\.c$/,
    pulls: /^iommu-updates-/ },
  { id: 'power', title: '전원 도메인·PM QoS·OPP·devfreq·interconnect',
    headers: linuxH('pm_domain|pm_qos|pm_opp|pm_clock|devfreq|devfreq_cooling|interconnect|interconnect-provider|thermal'),
    sources: /^drivers\/(?:pmdomain\/core\.c$|opp\/|devfreq\/devfreq\.c$|interconnect\/core\.c$|thermal\/thermal_core\.c$)/,
    pulls: /^(?:pmdomain-v|thermal-\d)/ },
  { id: 'phy', title: 'PHY',
    headers: /^include\/linux\/phy\/(?:phy|phy-mipi-dphy)\.h$/,
    sources: /^drivers\/phy\/phy-core(?:-mipi-dphy)?\.c$/,
    pulls: /^phy-for-/ },
];

/** 코드에 든 영역 + 프로필이 더한 영역(config 의 extraAreas). 수집과 글 조립이 같은 목록을 써야 한다. */
export const areaDefs = (profile) => [...FOCUS_AREAS, ...(profile?.extraAreas || [])];

// ── 독자 프로필: "내 드라이버와 관련 있는가"를 트리 안 사용처로 가른다 ─────────────────

/**
 * config/driver-impact.json 의 profile → 정규식을 컴파일한 프로필. 없으면 아무 것도 "내 영역"이 아닌 중립 프로필이다.
 * groups[].paths 는 드라이버 파일 경로에 대는 정규식이다. 키워드(samsung 등)는 패널·노트북 드라이버까지 잡아 쓰지 않는다.
 * proxy 그룹은 "내 드라이버와 같은 종류의 드라이버"를 대신하는 넓은 경로다(미디어 플랫폼 드라이버 전체 등).
 */
export function compileProfile(raw = {}) {
  const re = (s, flags) => (s ? new RegExp(s, flags) : NEVER);
  return {
    id: raw.id || 'none',
    title: raw.title || '',
    reader: raw.reader || '',
    arch: raw.arch || [],
    foreign: re(raw.foreignSources),
    groups: (raw.groups || []).map((g) => ({ id: g.id, label: g.label || g.id, describe: g.describe || '', paths: re(g.paths), proxy: Boolean(g.proxy) })),
    primaryAreas: raw.primaryAreas || [],
    pullTags: re(raw.pulls?.tags),
    pullKeywords: re(raw.pulls?.keywords, 'i'),
    genericSubsystems: raw.genericSubsystems ?? 5,
    extraAreas: (raw.extraAreas || []).map((a) => ({ id: a.id, title: a.title, headers: re(a.headers), sources: re(a.sources), pulls: re(a.pulls) })),
  };
}

const subsystemOf = (file) => file.split('/').slice(0, 2).join('/');

/**
 * 바뀌거나 사라진 API 하나가 독자와 얼마나 가까운지. item.users 는 이전 버전에서 그 이름을 쓴 드라이버 파일이다.
 * mine: 프로필 경로의 드라이버가 썼다. generic: 여러 서브시스템이 쓴다(누구든 쓸 수 있는 범용 API).
 * other: 다른 서브시스템 안에서만 쓰거나, 프로필에 없는 아키텍처(arch/x86 등)·플랫폼(foreignSources: ACPI 등)이 정의한 것이다.
 * 트리 안 사용처로 가른 근사치라, 글은 other 를 지우지 않고 접어 둔다.
 */
export function relevance(item, profile) {
  const users = item.users || [];
  // 드라이버가 정의한 것을 트리에서 파일 하나만 쓰면 그 드라이버 안의 연결이다(v6.18 `cmdq_pkt_finalize`: mediatek soc → mediatek mdp3).
  // 같은 종류라는 이유(proxy)로는 세지 않는다. 내 플랫폼 경로의 드라이버가 썼다면 한 파일이어도 센다.
  const ownLink = users.length === 1 && DRIVER_PATH_RE.test(item.file || '');
  const groups = profile.groups
    .map((g) => ({ id: g.id, label: g.label, count: g.proxy && ownLink ? 0 : users.filter((f) => g.paths.test(f)).length }))
    .filter((g) => g.count > 0);
  const arch = /^arch\/([^/]+)\//.exec(item.file || '')?.[1];
  const foreign = Boolean(arch && profile.arch.length && !profile.arch.includes(arch)) || profile.foreign.test(item.file || '');
  const subsystems = new Set(users.map(subsystemOf)).size;
  const tier = foreign ? 'other' : groups.length ? 'mine' : subsystems >= profile.genericSubsystems ? 'generic' : 'other';
  return { tier, groups, subsystems };
}

// 선언 비교와 무관한 속성·저장 지정자. 괄호 인자가 붙으면 함께 지운다.
const ATTR_RE = /\b(?:__\w+__|__(?:always_inline|must_check|init|exit|cold|hot|pure|malloc|weak|deprecated|iomem|user|force|rcu|percpu|kernel|noreturn|maybe_unused|used|nocfi|noinline|ref|latent_entropy|noclone|flatten|section|aligned|packed|randomize_layout|no_randomize_layout|attribute_const|printf|scanf|alloc_size|realloc_size|nonnull|must_hold|acquires|releases|cond_acquires|cond_releases|counted_by\w*|no_sanitize\w*|no_kcsan|returns_nonnull|assume_aligned|access|guarded_by|pt_guarded_by|cacheline_aligned\w*|private|data_racy|nonstring|designated_init|ro_after_init|initdata|meminit|refdata)|____cacheline_aligned\w*|notrace|asmlinkage|noinstr|inline|extern|static)\b/g;
const TYPE_WORDS = new Set('void char short int long float double signed unsigned bool _Bool u8 u16 u32 u64 s8 s16 s32 s64 __u8 __u16 __u32 __u64 __s32 __le16 __le32 __le64 __be16 __be32 __be64 size_t ssize_t loff_t gfp_t dma_addr_t phys_addr_t resource_size_t ktime_t pgoff_t umode_t fmode_t pid_t atomic_t'.split(' '));

/** s[at] 가 여는 괄호일 때 짝이 맞는 닫는 괄호 다음 위치. */
function closeOf(s, at, open = '(', close = ')') {
  let depth = 0;
  for (let i = at; i < s.length; i += 1) {
    if (s[i] === open) depth += 1;
    else if (s[i] === close && --depth === 0) return i + 1;
  }
  return s.length;
}

function splitTop(s, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  return [...parts, cur].map((p) => p.trim()).filter(Boolean);
}

function stripAttrs(s) {
  let out = '';
  let at = 0;
  for (const m of s.matchAll(ATTR_RE)) {
    if (m.index < at) continue;
    out += s.slice(at, m.index);
    at = m.index + m[0].length;
    const paren = /^\s*\(/.exec(s.slice(at));
    if (paren) at = closeOf(s, at + paren[0].length - 1);
  }
  return (out + s.slice(at)).replace(/\s+/g, ' ').trim();
}

const tidy = (s) => (s.match(/[A-Za-z_]\w*|\.\.\.|\S/g) || []).join(' ').replace(/\* (?=\*)/g, '*');

/** 인자 하나에서 이름을 지운 타입. 함수 포인터 인자는 `ret (*)(args)` 로 둔다. */
function paramType(p) {
  const fp = /\(\s*\*\s*\w*\s*\)\s*\(/.exec(p);
  if (fp) {
    const open = fp.index + fp[0].length - 1;
    return `${tidy(p.slice(0, fp.index))} (*)(${paramTypes(p.slice(open + 1, closeOf(p, open) - 1))})`;
  }
  const arr = /(?:\s*\[[^\]]*\])+\s*$/.exec(p);
  const tokens = (arr ? p.slice(0, arr.index) : p).match(/[A-Za-z_]\w*|\.\.\.|\S/g) || [];
  const last = tokens.at(-1);
  if (tokens.length >= 2 && /^[A-Za-z_]/.test(last) && !TYPE_WORDS.has(last) && !/^(?:struct|union|enum)$/.test(tokens.at(-2))) tokens.pop();
  return tokens.join(' ').replace(/\* (?=\*)/g, '*') + (arr ? '[]' : '');
}

const paramTypes = (s) => splitTop(s, ',').map(paramType).join(', ');

/** 최상위 선언 머리 → { name, sig } (함수만). 매크로 호출·함수 포인터 변수·초기화식은 null. */
function functionSig(head) {
  const h = stripAttrs(head);
  const open = h.indexOf('(');
  if (open < 0) return null;
  const m = /([A-Za-z_]\w*)\s*$/.exec(h.slice(0, open));
  const ret = m ? h.slice(0, m.index).trim() : '';
  if (!ret || ret.includes('=') || h.slice(closeOf(h, open)).trim()) return null;
  const type = tidy(ret);
  return { name: m[1], sig: `${type}${type.endsWith('*') ? '' : ' '}${m[1]}(${paramTypes(h.slice(open + 1, closeOf(h, open) - 1))})` };
}

/** 매크로 인자 안의 멤버 선언들. `struct_group(NAME, MEMBERS...)` 처럼 앞에 붙은 이름 인자는 버린다. */
function wrappedMembers(inner) {
  const [first = '', ...rest] = splitTop(inner, ';');
  const parts = splitTop(first, ',');
  while (parts.length > 1 && /^\w+$/.test(parts[0])) parts.shift();
  return `${[parts.join(', '), ...rest].join(';')};`;
}

/** 구조체 본문 → Map(member → Set(선언)). 안쪽 익명 struct·union 과 멤버를 감싼 매크로는 펼친다. */
function parseMembers(block) {
  const members = new Map();
  const add = (name, decl) => members.set(name, (members.get(name) || new Set()).add(decl));
  const flat = block.replace(/\b(?:struct|union|enum)(?:\s+\w+)?\s*\{/g, ';').replace(/\}[^;{}]*;/g, ';');
  for (const raw of splitTop(flat, ';')) {
    const stmt = stripAttrs(raw);
    // 멤버 선언을 감싼 매크로는 안쪽 선언을 멤버로 본다. v7.3 `kobj_attribute.show` 는 기존 타입과 const 타입을 함께 받게
    // `__SYSFS_FUNCTION_ALTERNATIVE(ssize_t (*show)(...); ssize_t (*show_const)(...);)` 로 감쌌을 뿐인데 타입 변경으로 잡혔다.
    const wrap = /^[A-Za-z_]\w*\s*\(/.exec(stmt);
    if (wrap) {
      const end = closeOf(stmt, wrap[0].length - 1);
      const inner = stmt.slice(wrap[0].length, end - 1);
      if (end === stmt.length && inner.includes(';')) {
        for (const [name, decls] of parseMembers(wrappedMembers(inner))) decls.forEach((d) => add(name, d));
        continue;
      }
    }
    let m = /\(\s*\*\s*(\w+)\s*\)\s*\(/.exec(stmt);
    if (m) {
      add(m[1], paramType(stmt));
      continue;
    }
    m = /^[A-Z][A-Z0-9_]*\s*\(\s*(\w+)/.exec(stmt); // DECLARE_BITMAP(name, n) 같은 매크로 멤버
    if (m) {
      add(m[1], tidy(stmt));
      continue;
    }
    const [first, ...rest] = splitTop(stmt, ',').map((d) => d.replace(/:\s*[\w\s()+-]+$/, ''));
    const one = first && /([A-Za-z_]\w*)((?:\s*\[[^\]]*\])*)\s*$/.exec(first);
    const type = one ? tidy(first.slice(0, one.index)) : '';
    if (!type) continue;
    add(one[1], `${type}${one[2] ? '[]' : ''}`);
    const base = type.replace(/[\s*]+$/, '');
    for (const d of rest) {
      const more = /^(\**)\s*(\w+)/.exec(d);
      if (more) add(more[2], `${base}${more[1] ? ` ${more[1]}` : ''}`);
    }
  }
  return members;
}

/**
 * 헤더 텍스트 → { decls: Map(name → {kind, sigs, file}), structs: Map(name → {file, members}) }.
 * kind: function·macro·constant(enum)·variable(extern)·struct. #ifdef 양쪽 선언은 모두 sigs 에 들어간다.
 */
export function parseHeaderApi(text, file = '') {
  const decls = new Map();
  const structs = new Map();
  const add = (name, kind, sig) => {
    const e = decls.get(name) || { kind, sigs: new Set(), file };
    e.sigs.add(sig);
    decls.set(name, e);
  };
  const clean = text.replace(/\\\r?\n/g, ' ').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
    (m) => (m[0] === '/' ? ` ${m.replace(/[^\n]/g, '')}` : `${m[0]}${m[0]}`));
  const code = clean.split('\n').map((line) => {
    const m = /^\s*#\s*define\s+([A-Za-z_]\w*)(\(([^)]*)\))?/.exec(line);
    const params = m?.[2] ? splitTop(m[3], ',') : null;
    if (m) add(m[1], 'macro', params ? (params.some((p) => p.trim().endsWith('...')) ? '(...)' : `(${params.length})`) : '');
    return /^\s*#/.test(line) ? '' : line;
  }).join('\n');

  let head = '';
  let paren = 0;
  let tail = false; // 구조체·초기화식 블록 뒤 `;` 까지는 버린다
  const emit = () => {
    const raw = head.trim();
    head = '';
    if (tail || !raw || /^typedef\b/.test(raw)) return;
    const fn = functionSig(raw);
    if (fn) add(fn.name, 'function', fn.sig);
    else if (/^extern\b/.test(raw) && !raw.includes('(')) {
      const v = /([A-Za-z_]\w*)((?:\s*\[[^\]]*\])*)\s*$/.exec(stripAttrs(raw));
      if (v) add(v[1], 'variable', tidy(stripAttrs(raw).slice(0, v.index)) + (v[2] ? '[]' : ''));
    }
  };
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    if (ch === '{' && paren === 0) {
      const end = closeOf(code, i, '{', '}');
      const block = code.slice(i + 1, end - 1);
      const def = /^(?:typedef\s+)?(struct|union|enum)\s*(\w*)$/.exec(stripAttrs(head));
      if (def?.[1] === 'enum') {
        for (const item of splitTop(block, ',')) {
          const c = /^([A-Za-z_]\w*)/.exec(item);
          if (c) add(c[1], 'constant', '');
        }
      } else if (def?.[2]) {
        add(def[2], 'struct', def[1]);
        const s = structs.get(def[2]) || { file, members: new Map() };
        for (const [member, sigs] of parseMembers(block)) s.members.set(member, new Set([...(s.members.get(member) || []), ...sigs]));
        structs.set(def[2], s);
      }
      if (!def && head.includes('(') && !head.includes('=')) emit(); // 함수 정의(static inline)
      else tail = true;
      head = '';
      i = end - 1;
    } else if (ch === ';' && paren === 0) {
      emit();
      tail = false;
    } else if (ch === '\n' && paren === 0 && /^\s*[A-Z][A-Z0-9_]*\s*\([\s\S]*\)\s*$/.test(head)) {
      head = ''; // `;` 없이 끝나는 매크로 호출(DEFINE_GUARD(...) 등)
    } else {
      head += ch;
    }
  }
  return { decls, structs };
}

/** 여러 헤더의 파싱 결과를 이름 하나로 합친다(헤더 사이 이동은 변화가 아니다). */
export function mergeHeaderApis(list) {
  const decls = new Map();
  const structs = new Map();
  for (const api of list) {
    for (const [name, e] of api.decls) {
      const cur = decls.get(name);
      if (cur) e.sigs.forEach((s) => cur.sigs.add(s));
      else decls.set(name, { ...e, sigs: new Set(e.sigs) });
    }
    for (const [name, s] of api.structs) {
      const cur = structs.get(name);
      if (!cur) structs.set(name, { file: s.file, members: new Map([...s.members].map(([k, v]) => [k, new Set(v)])) });
      else for (const [k, v] of s.members) cur.members.set(k, new Set([...(cur.members.get(k) || []), ...v]));
    }
  }
  return { decls, structs };
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * 같은 인자로 부르던 코드가 그대로 빌드되는 변화. 가변 인자 매크로와 고정 인자 사이(v7.2 `kmalloc(...)` →
 * `kmalloc(size, flags)`), 속성·주석 매크로가 한쪽에만 붙거나 빠진 것(v7.1 `jiffies`의 `__jiffy_arch_data`,
 * `__signed_wrap`, `__iomem`, 구조체 배치 표지 `randomized_struct_fields_end`)이다. 양쪽에 서로 다른 `__` 이름이
 * 있으면(`__u32` → `__le32`) 변화로 둔다.
 */
export function compatibleChange(was, now) {
  if (was === '(...)' || now === '(...)') return true;
  const words = (s) => s.match(/\b(?:__[a-z0-9_]+|randomized_struct_fields_(?:start|end))\b/g) || [];
  const gone = words(was).filter((w) => !words(now).includes(w));
  const added = words(now).filter((w) => !words(was).includes(w));
  if (gone.length > 0 === added.length > 0) return false;
  const drop = (s) => [...gone, ...added].reduce((t, w) => t.replace(new RegExp(`\\b${w}\\b`, 'g'), ' '), s)
    .replace(/\s*([(),*])\s*/g, '$1').replace(/\s+/g, ' ').trim();
  return drop(was) === drop(now);
}

/** 이전·이후 헤더 API → [{ change: removed|changed|added, kind, name, struct?, member?, before?, after?, file }]. */
export function diffHeaderApi(before, after) {
  const items = [];
  const changed = (b, a) => {
    const was = [...b].find((s) => !a.has(s));
    const now = [...a].find((s) => !b.has(s));
    return was !== undefined && now !== undefined && !compatibleChange(was, now) ? { before: was, after: now } : null;
  };
  for (const [name, b] of before.decls) {
    const a = after.decls.get(name);
    if (!a) items.push({ change: 'removed', kind: b.kind, name, before: [...b.sigs][0], file: b.file });
    else if (a.kind === b.kind && ['function', 'macro', 'variable'].includes(b.kind) && !sameSet(a.sigs, b.sigs)) {
      const diff = changed(b.sigs, a.sigs);
      if (diff) items.push({ change: 'changed', kind: b.kind, name, ...diff, file: a.file });
    }
  }
  for (const [name, a] of after.decls) {
    if (!before.decls.has(name)) items.push({ change: 'added', kind: a.kind, name, after: [...a.sigs][0], file: a.file });
  }
  for (const [struct, b] of before.structs) {
    const a = after.structs.get(struct);
    if (!a) continue;
    for (const [member, sigs] of b.members) {
      const now = a.members.get(member);
      const base = { kind: 'member', struct, member, name: `${struct}.${member}`, file: a.file };
      if (!now) items.push({ ...base, change: 'removed', before: [...sigs][0] });
      else if (!sameSet(sigs, now)) {
        const diff = changed(sigs, now);
        if (diff) items.push({ ...base, change: 'changed', ...diff });
      }
    }
    for (const [member, sigs] of a.members) {
      if (!b.members.has(member)) items.push({ kind: 'member', struct, member, name: `${struct}.${member}`, file: a.file, change: 'added', after: [...sigs][0] });
    }
  }
  return items;
}

// ── 새 태그 고르기 ───────────────────────────────────────────────────────

const TAG_RE = /^v(\d+)\.(\d+)(?:-rc(\d+))?$/;
const versionKey = (tag) => {
  const m = TAG_RE.exec(tag);
  return m && [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : Infinity];
};
const compareTags = (a, b) => {
  const [x, y] = [versionKey(a), versionKey(b)];
  return x[0] - y[0] || x[1] - y[1] || (x[2] === y[2] ? 0 : x[2] < y[2] ? -1 : 1);
};

/**
 * 아직 글이 없는 새 `-rc1`·정식 태그를 오래된 순으로 → [{ from, to }]. from 은 to 직전의 정식 릴리스다.
 * 글이 하나도 없으면 가장 최근 태그 하나만 고른다(과거를 소급하지 않는다).
 */
export function pendingTags(tags, doneTags) {
  const releases = tags.filter((t) => TAG_RE.test(t) && (!t.includes('-rc') || t.endsWith('-rc1'))).sort(compareTags);
  const finals = releases.filter((t) => !t.includes('-rc'));
  const done = doneTags.filter((t) => TAG_RE.test(t)).sort(compareTags);
  const todo = done.length ? releases.filter((t) => compareTags(t, done.at(-1)) > 0) : releases.slice(-1);
  return todo.map((to) => {
    const [major, minor] = versionKey(to);
    const from = finals.filter((t) => { const [a, b] = versionKey(t); return a < major || (a === major && b < minor); }).at(-1);
    return from ? { from, to } : null;
  }).filter(Boolean);
}

/**
 * 게시된 글 → 일반 노트가 끝낸 태그(pendingTags 용)와 LTS 노트 범위. LTS 노트(v6.18..v7.4 등)의 끝 태그를
 * 일반 노트가 끝낸 것으로 치면 그 버전의 일반 노트를 건너뛰므로 둘을 나눈다.
 */
export function postedRanges(posts) {
  const ranges = (lts) => posts.filter((p) => (p.draftMetadata?.kind === 'lts') === lts).map((p) => p.draftMetadata?.range).filter(Boolean);
  return { done: ranges(false).map((r) => r.split('..')[1]), lts: new Set(ranges(true)) };
}

/** kernel.org releases.json 의 longterm 목록 → 가장 최근 두 LTS 의 mainline 태그 쌍. 둘 다 저장소에 있어야 한다. */
export function ltsPair(releases, tags) {
  const have = new Set(tags);
  const lts = [...new Set(releases.filter((r) => r.moniker === 'longterm').map((r) => `v${r.version.split('.').slice(0, 2).join('.')}`))]
    .filter((t) => TAG_RE.test(t) && have.has(t)).sort(compareTags);
  return lts.length >= 2 ? { from: lts.at(-2), to: lts.at(-1) } : null;
}

// ── 글 조립 ─────────────────────────────────────────────────────────────

/** 수집 결과 형식 판. 2: 이름마다 사용 파일(users)을, 전환마다 건드린 디렉터리(dirNames)를 남긴다. 다르면 다시 수집한다. */
export const RAW_SCHEMA = 2;

const COMMIT_URL = 'https://git.kernel.org/torvalds/c/';
export const shortSha = (sha) => sha.slice(0, 12);
const commitUrl = (sha) => `${COMMIT_URL}${shortSha(sha)}`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const code = (s) => `\`${String(s).replace(/`/g, '')}\``;
const clip = (s, max = 120) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const REMOVED_LABEL = { function: '함수 삭제', macro: '매크로 삭제', constant: '상수 삭제', variable: '변수 삭제', struct: '구조체 삭제', member: '멤버 삭제', export: 'export 해제' };
const CHANGED_LABEL = { function: '시그니처 변경', macro: '매크로 인자 수 변경', variable: '타입 변경', member: '멤버 타입 변경', export: 'export 변경' };
const byUse = (a, b) => (b.driverUses ?? 0) - (a.driverUses ?? 0) || a.name.localeCompare(b.name);

/**
 * 함수의 반환형만 바뀐 변화인지와, 그중 기존 호출이 그대로 빌드되는 것(`void` → 값, `int` → `bool`)인지.
 * 콜백 멤버는 구현 쪽 함수의 반환형을 고쳐야 하므로 해당하지 않는다. v6.18 `v4l2_ctrl_handler_free()`(void → int)를
 * AI 가 "반환값을 받도록 고친다"로 써서 헤드라인에 올랐다.
 */
export function returnChange(r) {
  if (r.kind !== 'function' || r.change !== 'changed' || !r.before || !r.after) return { only: false, callersBuild: false };
  const split = (sig) => { const at = sig.indexOf(`${r.name}(`); return at < 0 ? null : [sig.slice(0, at).trim(), sig.slice(at)]; };
  const [was, now] = [split(r.before), split(r.after)];
  const only = Boolean(was && now && was[1] === now[1] && was[0] !== now[0]);
  return { only, callersBuild: only && (was[0] === 'void' || (was[0] === 'int' && now[0] === 'bool')) };
}
const isFixPull = (p) => /\bfix(?:es)?\b|urgent/i.test(`${p.tag || ''} ${p.title}`);

export function isDriverPull(p) {
  return p.driverFiles >= 5 || (p.files > 0 && p.driverFiles / p.files >= 0.3);
}

/** 지워진 export 와 헤더 선언을 이름 하나로 합치고 이전 버전 드라이버 사용 파일 수 순으로 둔다. */
export function removedApis(data) {
  const byName = new Map();
  for (const e of data.exports.removed) {
    if (e.header === 'inline') continue;
    byName.set(e.name, { ...e, kind: e.header === 'declared' ? `export 해제(선언은 남음) ${e.kind}` : `export ${e.kind}` });
  }
  for (const h of data.headers) if (!byName.has(h.name)) byName.set(h.name, h);
  return [...byName.values()].sort(byUse);
}

/**
 * 중점 영역마다 드라이버가 쓰던 API 의 변화(헤더 비교 + 영역 소스의 export 변화), 새 이름, 관련 pull.
 * rows 는 사용 파일 수 순서이고 rel(프로필 기준 관련도)이 붙는다. 한 이름은 먼저 나온 영역 하나에만 둔다.
 */
export function focusAreas(data, profile = compileProfile()) {
  const renamed = new Map([...data.exports.removed, ...data.headers].filter((e) => e.commit?.renamedTo).map((e) => [e.name, e.commit.renamedTo]));
  const taken = new Set();
  return areaDefs(profile).map((area) => {
    const found = (data.focus || []).find((f) => f.id === area.id) || { files: 0, items: [] };
    const exportRows = [
      ...data.exports.removed.filter((e) => area.sources.test(e.file) && e.header !== 'inline' && e.driverUses > 0)
        .map((e) => ({ change: 'removed', kind: 'export', name: e.name, before: e.kind, driverUses: e.driverUses, users: e.users, file: e.file, commit: e.commit })),
      ...data.exports.changed.filter((c) => area.sources.test(c.file))
        .map((c) => ({ change: 'changed', kind: 'export', name: c.name, before: c.from, after: c.to, driverUses: c.users ? c.users.length : null, users: c.users, file: c.file, commit: null })),
    ];
    const rows = [...found.items.filter((i) => i.change !== 'added'), ...exportRows]
      .map((r) => (r.change === 'removed' && renamed.get(r.name) ? { ...r, renamedTo: renamed.get(r.name) } : r))
      .filter((r) => !taken.has(r.name) && taken.add(r.name))
      .map((r) => ({ ...r, rel: relevance(r, profile) }))
      .sort(byUse);
    return {
      id: area.id,
      title: area.title,
      primary: profile.primaryAreas.includes(area.id),
      files: found.files,
      rows,
      added: found.items.filter((i) => i.change === 'added').map((i) => i.name),
      same: found.same || {},
      pulls: data.pulls.filter((p) => area.pulls.test(p.tag) && !isFixPull(p)),
    };
  });
}

const profileActive = (profile) => profile.groups.length > 0 || profile.primaryAreas.length > 0;
/** 프로필 경로에 든 디렉터리 수를 그룹별로. 전환 커밋이 내 영역을 건드렸는지 본다. */
const touched = (c, profile) => profile.groups
  .map((g) => ({ label: g.label, count: (c.dirNames || []).filter((d) => g.paths.test(`${d}/`)).length }))
  .filter((g) => g.count > 0);
const touchCount = (c, profile) => touched(c, profile).reduce((n, g) => n + g.count, 0);
const nearBroad = (c, profile) => touchCount(c, profile) > 0;
// 반복 패턴은 내 영역 디렉터리 세 곳 이상에서 되풀이된 것만: 한두 곳만 걸친 정리성 패턴(dev_err 제거 등)까지 올리면 볼 것이 흐려진다.
const nearCampaign = (c, profile) => touchCount(c, profile) >= 3;
const byTouch = (profile) => (a, b) => touchCount(b, profile) - touchCount(a, profile);

/** pull 요약에서 키워드가 나온 항목(목록 한 칸이나 문단)만. 서브시스템 전체 요약을 내 영역 요약으로 읽지 않게 한다. */
function keywordExcerpt(summary, re, max = 1200) {
  const blocks = [];
  let cur = null; // 지금 블록 첫 줄의 들여쓰기와 목록 여부
  for (const line of summary.split('\n')) {
    const indent = line.search(/\S/);
    const bullet = /^\s*[-*]\s/.test(line);
    if (indent < 0) {
      cur = null;
    } else if (!cur || bullet || (cur.bullet ? indent <= cur.indent : indent < cur.indent) || /:\s*$/.test(blocks.at(-1))) {
      blocks.push(line); // 목록 한 칸의 이어지는 줄은 그 칸보다 깊게 들여쓴다. 덜 들여쓴 줄은 다음 소제목이다.
      cur = { indent, bullet };
    } else {
      blocks[blocks.length - 1] += `\n${line}`;
    }
  }
  const out = [];
  let under = -1; // 키워드가 나온 소제목("  exynos:")의 들여쓰기. 그보다 깊은 다음 항목은 그 소제목에 딸린 목록이다.
  for (const block of blocks) {
    const indent = block.search(/\S/);
    if (re.test(block)) {
      out.push(block);
      under = /:\s*$/.test(block) ? indent : -1;
    } else if (under >= 0 && indent > under) out.push(block);
    else under = -1;
  }
  return out.join('\n').slice(0, max);
}

/**
 * AI 에 넘길 입력. 프로필이 있으면 독자와 가까운 것(`mine`)을 앞에 두고, 다른 서브시스템 전용으로 사라진 API 는 상위 몇 개만 넣는다.
 * messages 는 입력에 든 항목의 커밋 제목·본문만 남긴다.
 */
export function buildAiInput(data, profile = compileProfile(), { maxPulls = 20, areaPulls = 2, summaryChars = 2500, otherSummaryChars = 1200, messageChars = 60000 } = {}) {
  const areas = focusAreas(data, profile);
  const active = profileActive(profile);
  const mineFirst = (list, isMine) => [...list].sort((a, b) => Number(isMine(b)) - Number(isMine(a)));
  const flag = (yes) => (yes ? { mine: true } : {});

  // 영역 pull 은 바뀐 것이 있는 영역에서 드라이버를 많이 건드린 순으로 areaPulls 개만(LTS 구간은 영역마다 릴리스 수만큼 있다).
  const areaPull = (a) => (a.rows.length ? [...a.pulls].sort((x, y) => y.driverFiles - x.driverFiles).slice(0, areaPulls) : []);
  const focus = areas.map((a) => {
    const mine = (r) => active && (a.primary || r.rel.tier === 'mine');
    return {
      id: a.id,
      title: a.title,
      changes: mineFirst(a.rows, mine).slice(0, 25).map((r) => ({
        change: r.change, kind: r.kind, name: r.name, ...(r.before ? { before: r.before } : {}), ...(r.after ? { after: r.after } : {}),
        ...(r.renamedTo ? { renamedTo: r.renamedTo } : {}), driverUses: r.driverUses, commit: r.commit ? shortSha(r.commit.sha) : null, ...flag(mine(r)),
        ...(returnChange(r).callersBuild ? { callersBuild: true } : {}),
      })),
      pulls: areaPull(a).map((p) => shortSha(p.sha)), // 새 이름 목록은 주지 않는다: 이름만 보고 용도를 짐작하게 된다
      ...(Object.keys(a.same).length ? { unchangedMembers: a.same } : {}),
    };
  });

  const byTag = (p) => profile.pullTags.test(p.tag || '');
  const minePull = (p) => !isFixPull(p) && (byTag(p) || profile.pullKeywords.test(p.summary || ''));
  const minePulls = mineFirst(data.pulls.filter(minePull).sort((a, b) => b.driverFiles - a.driverFiles), byTag).slice(0, 10);
  const focusPulls = new Set(areas.flatMap((a) => areaPull(a).map((p) => p.sha)));
  const pulls = [
    ...minePulls,
    ...data.pulls.filter((p) => isDriverPull(p) && !/\bfix(?:es)?\b/i.test(p.title)).sort((a, b) => b.driverFiles - a.driverFiles).slice(0, maxPulls),
    ...data.pulls.filter((p) => focusPulls.has(p.sha)),
  ].filter((p, i, all) => all.findIndex((q) => q.sha === p.sha) === i).map((p) => {
    const mine = minePulls.includes(p);
    // 키워드로만 걸린 pull 은 그 키워드가 나온 대목만 준다(clk pull 전체가 아니라 Samsung 대목).
    const summary = mine && !byTag(p) ? keywordExcerpt(p.summary, profile.pullKeywords) : p.summary.slice(0, mine ? summaryChars : otherSummaryChars);
    return { id: shortSha(p.sha), title: p.title, summary, ...flag(mine) };
  });

  const inFocus = new Set(areas.flatMap((a) => a.rows.map((r) => r.name)));
  const loose = removedApis(data).filter((e) => e.driverUses > 0 && !inFocus.has(e.name)).map((e) => ({ ...e, tier: relevance(e, profile).tier }));
  const pick = active
    ? [...loose.filter((e) => e.tier === 'mine').slice(0, 30), ...loose.filter((e) => e.tier === 'generic').slice(0, 20), ...loose.filter((e) => e.tier === 'other').slice(0, 10)]
    : loose.slice(0, 40);
  const apiRemovals = pick.map((e) => ({
    name: e.name, kind: e.kind, driverUses: e.driverUses,
    commit: e.commit ? shortSha(e.commit.sha) : null, ...(e.commit?.renamedTo ? { renamedTo: e.commit.renamedTo } : {}), ...flag(active && e.tier === 'mine'),
  }));

  const broadNear = (c) => nearBroad(c, profile);
  const campaignNear = (c) => nearCampaign(c, profile);
  const conversions = [
    ...mineFirst(data.broad, broadNear).slice(0, 20).map((c) => ({ id: shortSha(c.sha), subject: c.subject, driverDirs: c.dirs, ...flag(broadNear(c)) })),
    ...mineFirst(data.campaigns, campaignNear).slice(0, 12).map((c) => ({ id: shortSha(c.commits[0]), pattern: c.pattern, commits: c.count, subsystems: c.prefixes.slice(0, 8), ...flag(campaignNear(c)) })),
  ];

  // 커밋 제목도 함께 준다: "Rename a() to b()" 처럼 대체 이름이 제목에만 있는 커밋이 많다.
  // 본문은 독자와 가까운 항목의 커밋부터 messageChars 까지만 싣고, 넘치면 제목만 준다(LTS 구간은 인용 커밋이 수백 개다).
  const citing = [...focus.flatMap((f) => f.changes.map((c) => [c.commit, c.mine])), ...apiRemovals.map((a) => [a.commit, a.mine]), ...conversions.map((c) => [c.id, c.mine])].filter(([id]) => id);
  const cited = [...new Set(mineFirst(citing, ([, mine]) => Boolean(mine)).map(([id]) => id))];
  const subjects = new Map([...areas.flatMap((a) => a.rows), ...loose].filter((r) => r.commit?.subject).map((r) => [shortSha(r.commit.sha), r.commit.subject]));
  const bodies = new Map(Object.entries(data.messages).map(([sha, body]) => [shortSha(sha), body]));
  let budget = messageChars;
  const messages = Object.fromEntries(cited.map((id) => {
    const body = budget > 0 ? bodies.get(id) : undefined;
    budget -= body?.length || 0;
    return [id, [subjects.get(id), body].filter(Boolean).join('\n\n')];
  }).filter(([, text]) => text));
  return { range: { from: data.range.from, to: data.range.to }, ...(profile.reader ? { reader: profile.reader } : {}), focus, pulls, apiRemovals, conversions, messages };
}

// 영문 사이에 한글이 끼어든 토큰("fl사/eject")과 한자·가나는 모델 출력이 깨진 흔적이다.
const GARBLED_RE = /[A-Za-z][가-힣]{1,2}[A-Za-z/]|[぀-ヿ一-鿿]/;
// 입력 JSON 필드 이름이 글에 새면 안 된다.
const INPUT_FIELD_RE = /\b(?:unchangedMembers|apiRemovals|driverUses|renamedTo|focusNotes|conversionNotes|apiNotes)\b/;
// 입력에 없는 영향·할 일을 덧붙인 문장. v7.3 글의 "GPIOLIB_LEGACY 선택이 필요한 조합이 생겼다"(실제로는 def_bool y)처럼
// pull 요약을 부풀린 문장이 읽는 사람에게 "빌드가 깨진다"로 전해졌다. 사실은 표와 요약에 남으므로 문장만 버린다.
const SPECULATION_RE = /영향을 (?:줄|미칠) 수 있|점검한다|점검해야|점검이 필요|확인이 필요/;
// 글이 아니라 입력을 가리키는 말(v7.3: "메시지에 적힌 대로 `delay_read_timer`를 쓴다"). 독자는 그 "메시지"를 보지 못한다.
const META_RE = /메시지에 (?:적힌|따르면)|메시지대로|요약에 (?:적힌|따르면)|입력(?:에 |된 | JSON)/;
// 기존 호출이 그대로 빌드되는 변화(callersBuild)를 "고쳐야 한다"고 쓴 문장.
const MUST_FIX_RE = /고친다|고쳐야|맞춘다|맞춰야|수정한다|수정해야|받도록/;

/**
 * AI 출력에서 입력에 있는 id·이름을 가리키는 항목만 남긴다. 길이를 넘기거나 URL 을 넣었거나,
 * 백틱으로 감싼 이름이 입력에 없거나, 글자가 깨졌거나, 입력에 없는 영향·할 일을 덧붙였거나, 기존 호출이 그대로 빌드되는 변화를
 * 고치라고 쓴 항목은 버린다.
 * overview 는 독자와 가까운(`mine`) 근거를 든 항목이 있으면 그것만 남긴다.
 * 반환: { notes, dropped } — dropped 는 버린 항목 수.
 */
export function cleanNotes(raw, input) {
  const pullIds = new Set(input.pulls.map((p) => p.id));
  const convIds = new Set(input.conversions.map((c) => c.id));
  const changes = (input.focus || []).flatMap((f) => f.changes);
  const apiNames = new Set([...input.apiRemovals.map((a) => a.name), ...changes.map((c) => c.name)]);
  const near = new Set([...input.pulls, ...input.conversions].filter((x) => x.mine).map((x) => x.id)
    .concat([...input.apiRemovals, ...changes].filter((x) => x.mine).map((x) => x.name)));
  // 이름 변경 후보(renamedTo)는 "같은 커밋이 이름 하나를 더했다"는 추정이라 근거로 치지 않는다. 커밋 제목·본문이나
  // pull 요약에 그 이름이 있어야 "대신 쓴다"고 쓸 수 있다(v7.4-rc1 `fd_prepare_fd` → `__FD_PREPARE` 는 대체가 아니었다).
  const haystack = JSON.stringify(input, (key, value) => (key === 'renamedTo' ? undefined : value));
  const harmless = new Set(changes.filter((c) => c.callersBuild).map((c) => c.name));
  // 근거로 든 API 가 모두 "기존 호출은 그대로 빌드"인데 고치라고 쓴 문장
  const overstates = (s, names) => names.length > 0 && names.every((n) => harmless.has(n)) && MUST_FIX_RE.test(s);
  const ticked = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\(\)$/, ''));
  const grounded = (s) => ticked(s).every((t) => haystack.includes(t.split('*')[0]));
  // 헤더 비교로 그대로인 멤버를, 같은 구조체의 바뀐 멤버와 함께 바뀌었다고 쓴 문장(요약·커밋 메시지를 따른 오류).
  const sameMembers = (input.focus || []).flatMap((f) => Object.entries(f.unchangedMembers || {}).map(([struct, same]) => ({
    same: new Set(same), changed: f.changes.filter((c) => c.name.startsWith(`${struct}.`)).map((c) => c.name.slice(struct.length + 1)),
  })));
  // `get_fmt` 처럼 구별되는 이름(밑줄 포함, 6자 이상)은 언급만 해도, `name` 같은 흔한 이름은 바뀐 멤버와 함께 쓸 때만 버린다.
  const changedNames = new Set(changes.flatMap((c) => c.name.split('.')));
  const distinct = new Set(sameMembers.flatMap(({ same }) => [...same]).filter((m) => m.includes('_') && m.length >= 6 && !changedNames.has(m)));
  const contradicts = (s) => {
    const names = ticked(s).flatMap((t) => t.split(/[.\s(),*]+/));
    return names.some((n) => distinct.has(n))
      || sameMembers.some(({ same, changed }) => names.some((n) => same.has(n)) && names.some((n) => changed.includes(n)));
  };
  const text = (s, max) => (typeof s === 'string' && s.trim() && s.length <= max && !/https?:\/\//.test(s)
    && !GARBLED_RE.test(s) && !INPUT_FIELD_RE.test(s) && !SPECULATION_RE.test(s) && !META_RE.test(s) && grounded(s) && !contradicts(s) ? s.trim() : null);
  let dropped = 0;
  const keep = (list, fn) => (Array.isArray(list) ? list : []).flatMap((item) => {
    const value = item && typeof item === 'object' ? fn(item) : null;
    if (!value) dropped += 1;
    return value ? [value] : [];
  });
  // 대체 이름만 달랑 준 답("delay_read_timer")은 문장 꼴로 바꾼다. 백틱이 붙으므로 다른 문장과 똑같이 근거를 검사한다.
  const replacement = (s) => {
    const bare = /^`?([A-Za-z_]\w*)(?:\(\))?`?\.?$/.exec(typeof s === 'string' ? s.trim() : '');
    return text(bare ? `대신 쓸 것: \`${bare[1]}\`` : s, 300);
  };
  const overview = keep(raw.overview, (o) => {
    const refs = (Array.isArray(o.refs) ? o.refs : []).filter((r) => pullIds.has(r) || convIds.has(r) || apiNames.has(r));
    const t = text(o.text, 400);
    return t && refs.length && !overstates(t, refs.filter((r) => apiNames.has(r))) ? { text: t, refs } : null;
  });
  const nearFirst = overview.filter((o) => o.refs.some((r) => near.has(r)));
  const notes = {
    // 프로필이 있는 글의 "먼저 볼 것"은 독자와 가까운 것만 남긴다. 다른 서브시스템 안에서만 쓰던 API 로 채우느니 짧은 편이 낫다.
    overview: (nearFirst.length ? nearFirst : overview).slice(0, 5),
    apiNotes: new Map(keep(raw.apiNotes, (n) => (apiNames.has(n.name) && replacement(n.replacement) && !overstates(n.replacement, [n.name]) ? [n.name, replacement(n.replacement)] : null))),
    conversionNotes: new Map(keep(raw.conversionNotes, (n) => (convIds.has(n.id) && text(n.action, 300) ? [n.id, text(n.action, 300)] : null))),
    subsystems: new Map(keep(raw.subsystems, (s) => {
      const points = (Array.isArray(s.points) ? s.points : []).map((p) => text(p, 400)).filter(Boolean).slice(0, 4);
      return pullIds.has(s.id) && points.length ? [s.id, points] : null;
    })),
  };
  return { notes, dropped };
}

const EMPTY_NOTES = { overview: [], apiNotes: new Map(), conversionNotes: new Map(), subsystems: new Map() };

function kstDate(iso) {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 오타·링크·담당자 변경처럼 드라이버가 따라 할 것이 없는 문서 커밋.
const DOC_NOISE_RE = /typo|spelling|grammar|word order|dead link|\burl\b|maintainer|kernel-?doc|whitespace|copyright|spdx/i;
const TOP_CAP = 12; // 영역마다 펼쳐 두는 항목 수. 나머지는 같은 자리에 접는다.
const TABLE_CAP = 50;

/** 접어 두는 블록. 사이트 렌더러(marked)는 HTML 블록 안의 빈 줄 뒤 마크다운을 그대로 렌더링한다. */
const fold = (title, body) => `<details>\n<summary><strong>${title}</strong></summary>\n\n${body}\n\n</details>`;

/**
 * 수집 사실 + (있으면) AI 요약 → Dev Blog 글 JSON. 표·명령·링크는 모두 코드가 만든다.
 * 프로필이 있으면 독자의 드라이버가 쓰던 것을 위에 펼치고, 여러 서브시스템이 쓰는 것을 다음에, 나머지는 접어 둔다. 한 이름은 한 곳에만 나온다.
 * lts: LTS → 다음 LTS 노트. 같은 끝 버전의 일반 노트와 id·제목이 겹치지 않고 draftMetadata.kind 로 구분한다.
 */
export function buildPost(data, input, notes = EMPTY_NOTES, { lts = false, profile = compileProfile() } = {}) {
  const { from, to, toDate, commits, merges } = data.range;
  const version = to.replace(/^v/, '');
  const label = lts ? `LTS ${from} → LTS ${to}` : `${from} → ${to}`;
  const active = profileActive(profile);
  const areas = focusAreas(data, profile);
  const areaRows = areas.flatMap((a) => a.rows.map((r) => ({
    ...r, area: a, label: returnChange(r).only ? '반환형 변경' : (r.change === 'removed' ? REMOVED_LABEL : CHANGED_LABEL)[r.kind] || r.change,
  })));
  const inFocus = new Set(areaRows.map((r) => r.name));
  const apis = removedApis(data);
  const used = apis.filter((e) => e.driverUses > 0);
  const loose = used.filter((e) => !inFocus.has(e.name)).map((e) => ({
    ...e, change: 'removed', renamedTo: e.commit?.renamedTo, rel: relevance(e, profile),
    label: /^export 해제/.test(e.kind) ? 'export 해제(선언은 남아 링크에서 실패)' : /^export /.test(e.kind) ? 'export 해제' : REMOVED_LABEL[e.kind] || '삭제',
  }));
  const driverKconfig = data.kconfig.removed.filter((k) => /^(?:drivers|sound)\//.test(k.file))
    .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  // 한 이름은 세 자리 가운데 하나에만: 독자의 드라이버가 쓰던 것(top) → 여러 서브시스템이 쓰는 것(generic) → 나머지(other).
  const isTop = (r) => active && (Boolean(r.area?.primary) || r.rel.tier === 'mine');
  const everything = [...areaRows, ...loose];
  const top = everything.filter(isTop);
  const generic = everything.filter((r) => !isTop(r) && r.rel.tier === 'generic').sort(byUse);
  const other = everything.filter((r) => !isTop(r) && r.rel.tier === 'other').sort(byUse);

  const pullById = new Map(input.pulls.map((p) => [p.id, p]));
  const commitLink = (c) => (c ? `[${cell(c.subject)}](${commitUrl(c.sha)})` : '');
  const groupCounts = (files) => profile.groups.map((g) => ({ label: g.label, count: files.filter((f) => g.paths.test(f)).length })).filter((g) => g.count > 0);
  const usage = (files, total) => {
    if (total == null) return '';
    const mine = groupCounts(files).map((g) => `${g.label} ${g.count}`).join(' · ');
    return mine ? `사용 ${mine} · 전체 ${total}개 파일` : `사용 ${total}개 파일`;
  };
  const macroArgs = (s) => (s === '(...)' ? '가변 인자' : /^\(\d+\)$/.test(s) ? `인자 ${s.slice(1, -1)}개` : '');
  // 이름 변경 후보는 "같은 커밋이 이름 하나를 더했다"는 사실일 뿐이라 대체 API 라고 단정하지 않는다.
  const instead = (r) => notes.apiNotes.get(r.name) || (r.renamedTo ? `같은 커밋에서 ${code(r.renamedTo)} 추가(이름 변경 후보)` : '');

  // 펼쳐 보이는 항목: 이름·변화·사용처·커밋 한 줄 아래에 이전·이후와 할 일을 둔다. 시그니처는 자르지 않는다.
  const detail = (r) => {
    const out = [];
    if (r.kind === 'macro') {
      if (r.change === 'changed') out.push(`${macroArgs(r.before)} → ${macroArgs(r.after)}`);
    } else if (r.kind === 'export') {
      out.push(r.change === 'changed' ? `${code(r.before)} → ${code(r.after)}` : `이전 ${code(r.before)}`);
    } else if (r.before && !/^(?:struct|union)$/.test(r.before)) {
      out.push(`이전 ${code(r.before)}`);
      if (r.change === 'changed') out.push(`이후 ${code(r.after)}`);
      if (returnChange(r).callersBuild) out.push('기존 호출은 그대로 빌드된다.');
    } else if (/^export /.test(r.kind || '')) {
      out.push(`이전 ${code(r.kind.replace(/^export (?:해제\(선언은 남음\) )?/, ''))}`);
    }
    const todo = instead(r);
    return todo ? [...out, todo] : out;
  };
  const head = (name, what, files, total, links) => `- **${code(name)}** — ${[what, usage(files, total), ...links].filter(Boolean).join(' · ')}`;
  const itemBlock = (r) => [head(r.name, r.label, r.users || [], r.driverUses, [commitLink(r.commit)]), ...detail(r).map((l) => `  - ${l}`)].join('\n');
  // 같은 구조체의 멤버 변화는 한 덩어리로 묶는다(v7.4-rc1 `v4l2_subdev_pad_ops` 의 set_fmt·get_selection·set_selection).
  const structBlock = (struct, rows) => {
    const files = [...new Set(rows.flatMap((r) => r.users || []))];
    const count = (change, word) => { const n = rows.filter((r) => r.change === change).length; return n ? `멤버 ${n}개 ${word}` : ''; };
    const links = [...new Map(rows.filter((r) => r.commit).map((r) => [r.commit.sha, r.commit])).values()].slice(0, 3).map(commitLink);
    const members = rows.map((r) => (r.change === 'changed'
      ? `  - ${code(r.member)}: ${code(r.before)} → ${code(r.after)}`
      : `  - ${code(r.member)} 삭제${r.before ? ` (이전 ${code(r.before)})` : ''}`));
    const todo = [...new Set(rows.map((r) => notes.apiNotes.get(r.name)).filter(Boolean))].map((t) => `  - ${t}`);
    return [head(`struct ${struct}`, [count('changed', '타입 변경'), count('removed', '삭제')].filter(Boolean).join(', '), files, files.length || Math.max(...rows.map((r) => r.driverUses ?? 0)), links), ...members, ...todo].join('\n');
  };
  // 한 커밋이 셋 이상 지운 이름도 한 덩어리로(v7.2: 플랫폼 데이터 헤더 하나를 지운 커밋의 `LM3560_*` 매크로 13개).
  const removedTogether = (rows) => {
    const files = [...new Set(rows.flatMap((r) => r.users || []))];
    const names = `${rows.slice(0, 4).map((r) => code(r.name)).join(', ')}${rows.length > 4 ? ` 외 ${rows.length - 4}개` : ''}`;
    const labels = [...new Set(rows.map((r) => r.label))];
    return `- **${names}** — ${[`${labels[0]}${labels.length > 1 ? ' 등' : ''} ${rows.length}개`, usage(files, files.length || rows[0].driverUses), commitLink(rows[0].commit)].filter(Boolean).join(' · ')}`;
  };
  const blocks = (rows) => {
    const out = [];
    const groups = new Map();
    const sameCommit = new Map();
    for (const r of rows) if (r.kind !== 'member' && r.change === 'removed' && r.commit) sameCommit.set(r.commit.sha, (sameCommit.get(r.commit.sha) || 0) + 1);
    for (const r of rows) {
      const key = r.kind === 'member' ? `struct:${r.struct}` : r.change === 'removed' && sameCommit.get(r.commit?.sha) >= 3 ? `commit:${r.commit.sha}` : null;
      if (!key) out.push({ rows: [r] });
      else if (groups.has(key)) groups.get(key).rows.push(r);
      else { groups.set(key, { key, rows: [r] }); out.push(groups.get(key)); }
    }
    return out.map((g) => (!g.key ? itemBlock(g.rows[0]) : g.key.startsWith('struct:') ? structBlock(g.rows[0].struct, g.rows) : removedTogether(g.rows)));
  };
  const capped = (title, list) => [list.slice(0, TOP_CAP).join('\n'), list.length > TOP_CAP ? fold(`${title} 나머지 ${list.length - TOP_CAP}개`, list.slice(TOP_CAP).join('\n')) : ''].filter(Boolean).join('\n\n');

  // 접어 두는 표: 같은 커밋이 셋 이상 지운 이름은 한 줄로 묶는다(드라이버를 통째로 지운 커밋이 표를 채우지 않게).
  const what = (r) => {
    if (r.before === undefined && r.after === undefined) return instead(r) || '—';
    if (r.change === 'changed') return `${code(clip(r.before))} → ${code(clip(r.after))}`;
    return `${r.before ? code(clip(r.before)) : '—'}${r.renamedTo ? ` → ${code(r.renamedTo)} (같은 커밋에서 추가)` : ''}`;
  };
  const tableRows = (list) => {
    const groups = new Map();
    for (const r of list) {
      const key = r.commit?.sha || `name:${r.name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups.values()].flatMap((g) => (g.length < 3
      ? g.map((r) => `| ${code(r.name)} | ${cell(r.label)} | ${cell(what(r))} | ${r.driverUses ?? '—'} | ${commitLink(r.commit) || '—'} |`)
      : [`| ${g.slice(0, 3).map((r) => code(r.name)).join(', ')}${g.length > 3 ? ` 외 ${g.length - 3}개` : ''} | ${cell(g[0].label)}${g.some((r) => r.label !== g[0].label) ? ' 등' : ''} | — | ${g[0].driverUses ?? '—'} | ${commitLink(g[0].commit)} |`]));
  };
  const table = (list) => {
    const rows = tableRows(list);
    return [
      ['| 이름 | 변화 | 이전 → 이후 · 대신 쓸 것 | 사용 | 커밋 |', '|---|---|---|---:|---|', ...rows.slice(0, TABLE_CAP)].join('\n'),
      rows.length > TABLE_CAP ? `사용 수가 적은 나머지 ${rows.length - TABLE_CAP}줄은 표에서 뺐습니다. 이름은 모두 아래 점검 명령에 있습니다.` : '',
    ].filter(Boolean).join('\n\n');
  };

  const sections = [];
  if (notes.overview.length) sections.push({ heading: '먼저 볼 것', body: notes.overview.map((o) => `- ${o.text}`).join('\n') });

  const changedAreas = areas.filter((a) => a.rows.length).map((a) => `${a.title} ${a.rows.length}건`);
  const quietAreas = areas.filter((a) => !a.rows.length).map((a) => a.title);
  const orientation = `헤더를 비교한 영역 ${areas.length}개 가운데 ${from} 드라이버가 쓰던 API가 바뀐 곳은 ${changedAreas.join(', ') || '없습니다'}${changedAreas.length ? '입니다' : ''}.`
    + (quietAreas.length ? ` 바뀐 것이 없는 곳: ${quietAreas.join(', ')}.` : '');

  // 전환(넓은 범위 변경·반복 패턴)과 Kconfig·export 변경도 내 영역을 건드린 것만 위에 둔다.
  const mark = (c) => touched(c, profile).map((g) => `${g.label} ${g.count}곳`).join(' · ');
  const broadLine = (c) => {
    const action = notes.conversionNotes.get(shortSha(c.sha));
    return `- [${cell(c.subject)}](${commitUrl(c.sha)}) — 드라이버 디렉터리 ${c.dirs}곳${mark(c) ? `(${mark(c)})` : ''}, 파일 ${c.files}개.${action ? ` ${action}` : ''}`;
  };
  const campaignLine = (c) => {
    const more = c.prefixes.length > 6 ? ` 외 ${c.prefixes.length - 6}곳` : '';
    const action = notes.conversionNotes.get(shortSha(c.commits[0]));
    return `- **${cell(c.pattern)}** — 커밋 ${c.count}개 (${c.prefixes.slice(0, 6).join(', ')}${more})${mark(c) ? ` · ${mark(c)}` : ''}. ${action ? `${action} ` : ''}[예시](${commitUrl(c.commits[0])})`;
  };
  const isNearBroad = (c) => active && nearBroad(c, profile);
  const isNearCampaign = (c) => active && nearCampaign(c, profile);
  const looseChanged = data.exports.changed.filter((c) => !inFocus.has(c.name)).map((c) => ({ ...c, rel: relevance(c, profile) }));
  const mineChanged = looseChanged.filter((c) => active && c.rel.tier === 'mine');
  const mineKconfig = driverKconfig.filter((k) => profile.groups.some((g) => g.paths.test(k.file)));
  // pull 마다 AI 가 추린 점. AI 요약이 없으면(template) 링크만 한 줄로 잇는다.
  const pullNotes = (pulls) => (notes.subsystems.size
    ? pulls.filter((p) => notes.subsystems.has(p.id))
      .map((p) => `**${cell(p.title.replace(/^Pull\s+/, ''))}** · [머지](${commitUrl(p.id)})\n${notes.subsystems.get(p.id).map((pt) => `- ${pt}`).join('\n')}`).join('\n\n')
    : pulls.map((p) => `[${cell(p.title.replace(/^Pull\s+/, ''))}](${commitUrl(p.id)})`).join(' · '));

  if (active) {
    const parts = [];
    for (const a of [...areas.filter((x) => x.primary), ...areas.filter((x) => !x.primary)]) {
      const rows = top.filter((r) => r.area === a).sort((x, y) => y.rel.groups.reduce((n, g) => n + g.count, 0) - x.rel.groups.reduce((n, g) => n + g.count, 0) || byUse(x, y));
      if (rows.length) parts.push(`### ${a.title}\n\n${capped(a.title, blocks(rows))}`);
      else if (a.primary) parts.push(`### ${a.title}\n\n${a.files ? `헤더 ${a.files}개가 바뀌었지만 ${from} 드라이버가 쓰던 API의 삭제·시그니처 변경은 없습니다.` : '이번 범위에서 이 영역의 헤더는 바뀌지 않았습니다.'}`);
    }
    const topLoose = top.filter((r) => !r.area).sort(byUse);
    if (topLoose.length) parts.push(`### 그 밖에 사라진 API\n\n${capped('그 밖에 사라진 API', blocks(topLoose))}`);
    if (mineChanged.length) {
      parts.push(`### 라이선스·네임스페이스가 바뀐 export\n\n${mineChanged.map((c) => `- ${code(c.name)} — ${code(c.from)} → ${code(c.to)} · ${usage(c.users || [], c.users?.length ?? null)}`).join('\n')}`);
    }
    if (mineKconfig.length) {
      parts.push(`### 사라진 Kconfig 심볼\n\n${mineKconfig.map((k) => `- ${code(k.name)} (${cell(k.file)})${k.commit?.renamedTo ? ` → ${code(k.commit.renamedTo)}` : ''}${k.commit ? ` · ${commitLink(k.commit)}` : ''}`).join('\n')}`);
    }
    const conv = [
      ...data.broad.filter(isNearBroad).sort(byTouch(profile)).slice(0, 6).map(broadLine),
      ...data.campaigns.filter(isNearCampaign).sort(byTouch(profile)).slice(0, 6).map(campaignLine),
    ];
    if (conv.length) parts.push(`### 함께 볼 전환\n\n여러 드라이버를 한꺼번에 바꾼 커밋과 여러 서브시스템이 되풀이한 변경 가운데 이 영역을 건드린 것입니다.\n\n${conv.join('\n')}`);
    const nearPulls = pullNotes(input.pulls.filter((p) => p.mine));
    if (nearPulls) {
      parts.push(notes.subsystems.size
        ? `### 메인테이너 요약에서\n\n메인테이너가 pull 요청에 쓴 글을 줄인 것입니다. 위 항목과 달리 헤더로 확인한 내용이 아닙니다.\n\n${nearPulls}`
        : `### 관련 pull\n\n${nearPulls}`);
    }
    const scope = profile.groups.map((g) => `${g.label}(${g.describe || g.id})`).join(', ');
    const primary = areas.filter((a) => a.primary).map((a) => a.title).join(', ');
    sections.push({
      heading: `${profile.title}에서 볼 것`,
      body: [
        // 독자의 드라이버는 트리 밖에 있어 볼 수 없다. 무엇을 기준으로 골랐는지 숨기지 않는다.
        `메인라인 ${from} 트리에 들어 있는 ${scope} 드라이버가 실제로 쓰던 API 가운데 바뀌거나 사라진 것입니다.${primary ? ` ${primary} 영역은 사용처와 관계없이 모두 넣었습니다.` : ''} `
          + '트리 밖(사내) 드라이버를 직접 본 것이 아니라 같은 종류의 메인라인 드라이버로 가늠한 것이므로, 사내 드라이버만 쓰는 API는 아래 점검 명령으로 확인합니다.',
        ...(top.length ? [] : ['이 범위에서 해당하는 API 변경은 없습니다.']),
        ...parts,
        orientation,
      ].join('\n\n'),
    });
  }

  if (generic.length || !active) {
    sections.push({
      heading: '여러 서브시스템이 쓰는 API 변화',
      body: [
        `${from}에서 드라이버 서브시스템 ${profile.genericSubsystems}곳 이상이 쓰던 API입니다. 어느 드라이버든 쓰고 있을 수 있습니다.`,
        ...(active ? [] : [orientation]),
        generic.length ? capped('여러 서브시스템이 쓰는 API', blocks(generic)) : '해당하는 변경은 없습니다.',
      ].join('\n\n'),
    });
  }

  // 트리 전체 참고: 다른 서브시스템 안에서만 쓰이던 것과 목록성 자료. 모두 접어 둔다.
  const reference = [];
  if (other.length) {
    reference.push(fold(`다른 서브시스템 안에서만 쓰이던 API ${other.length}개`, [
      `${from}에 있던 export 심볼·헤더 함수·매크로·구조체 가운데 ${to}에서 사라진 것이 ${apis.length}개이고, 그중 ${from}의 drivers/·sound/에서 쓰이던 것이 ${used.length}개입니다. `
        + '`사용`은 그 이름을 쓴 파일 수입니다. 같은 커밋이 셋 이상 지운 이름은 한 줄로 묶었습니다.',
      table(other),
    ].join('\n\n')));
  }
  const restChanged = looseChanged.filter((c) => !mineChanged.includes(c));
  if (restChanged.length) {
    const groups = new Map();
    for (const c of restChanged) {
      const key = `${c.from}\0${c.to}\0${c.file}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const rows = [...groups.values()].sort((a, b) => b.length - a.length).slice(0, TABLE_CAP)
      .map((g) => `| ${g.slice(0, 3).map((c) => code(c.name)).join(', ')}${g.length > 3 ? ` 외 ${g.length - 3}개` : ''} | ${cell(g[0].from)} | ${cell(g[0].to)} | ${cell(g[0].file)} |`);
    reference.push(fold(`라이선스·네임스페이스가 바뀐 export ${restChanged.length}개`, [
      '`_GPL`이 붙으면 GPL이 아닌 모듈은 더 쓸 수 없고, 네임스페이스가 붙으면 `MODULE_IMPORT_NS()`가 필요합니다. '
        + '`EXPORT_SYMBOL_FOR_MODULES`처럼 받는 모듈을 정한 export는 트리 밖 모듈에서 쓸 수 없습니다.',
      ['| 심볼 | 이전 | 이후 | 파일 |', '|---|---|---|---|', ...rows].join('\n'),
    ].join('\n\n')));
  }
  const restKconfig = driverKconfig.filter((k) => !mineKconfig.includes(k));
  if (restKconfig.length) {
    const rows = restKconfig.slice(0, 60).map((k) => `| ${code(k.name)} | ${cell(k.file)} | ${k.commit?.renamedTo ? code(k.commit.renamedTo) : '—'} | ${commitLink(k.commit) || '—'} |`);
    reference.push(fold(`사라진 드라이버 Kconfig 심볼 ${restKconfig.length}개`, [
      `전체 ${data.kconfig.removed.length}개가 사라졌고 새로 ${data.kconfig.added}개가 생겼습니다. drivers/·sound/ 아래의 심볼은 defconfig나 \`depends on\`에 남아 있으면 경고 없이 빠집니다.`,
      ['| 심볼 | 위치 | 이름 변경 후보 | 지운 커밋 |', '|---|---|---|---|', ...rows].join('\n'),
      restKconfig.length > rows.length ? `나머지 ${restKconfig.length - rows.length}개는 점검 명령에 있습니다.` : '',
    ].filter(Boolean).join('\n\n')));
  }
  const restConv = [
    ...data.campaigns.filter((c) => !isNearCampaign(c)).slice(0, 12).map(campaignLine),
    ...data.broad.filter((c) => !isNearBroad(c)).slice(0, 15).map(broadLine),
  ];
  if (restConv.length) {
    reference.push(fold(`반복 전환 패턴 ${data.campaigns.length}건·넓은 범위 변경 ${data.broad.length}건`, [
      '여러 서브시스템이 같은 변경을 되풀이한 것과, 한 커밋이 여러 드라이버 디렉터리를 함께 바꾼 것입니다.',
      restConv.join('\n'),
    ].join('\n\n')));
  }
  const docCommits = data.docs.driverApi.filter((c) => !DOC_NOISE_RE.test(c.subject));
  if (data.docs.deprecated.trim() || docCommits.length) {
    reference.push(fold('폐기 예고·권장 방식 문서', [
      data.docs.deprecated.trim()
        ? `\`Documentation/process/deprecated.rst\`에 추가된 내용입니다.\n\n\`\`\`text\n${data.docs.deprecated.trim().slice(0, 4000)}\n\`\`\``
        : '이번 범위에서 `Documentation/process/deprecated.rst`는 바뀌지 않았습니다.',
      docCommits.length ? `\`Documentation/driver-api/\`를 바꾼 커밋(오타·링크 수정 제외) ${docCommits.length}개:\n\n${docCommits.slice(0, 20).map((c) => `- ${commitLink(c)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n')));
  }
  const restPulls = input.pulls.filter((p) => !(active && p.mine));
  const restPullNotes = pullNotes(restPulls);
  if (restPullNotes) {
    reference.push(fold(notes.subsystems.size ? `서브시스템별 pull 요약 ${restPulls.filter((p) => notes.subsystems.has(p.id)).length}건` : `드라이버를 많이 바꾼 pull ${restPulls.length}건`, [
      notes.subsystems.size ? '각 메인테이너가 pull 요청에 쓴 요약에서 드라이버에 영향 있는 점만 추렸습니다. 헤더로 확인한 내용이 아닙니다.' : '드라이버 파일을 많이 바꾼 pull 순서입니다.',
      restPullNotes,
    ].join('\n\n')));
  }
  const added = areas.filter((a) => a.added.length).map((a) => `- **${a.title}** ${a.added.length}개: ${a.added.slice(0, 30).map(code).join(', ')}${a.added.length > 30 ? ' …' : ''}`);
  if (added.length) reference.push(fold('중점 영역에 새로 생긴 함수·매크로·멤버', `이름만 적습니다. 용도는 각 헤더와 커밋을 봅니다.\n\n${added.join('\n')}`));
  if (reference.length) {
    sections.push({ heading: '트리 전체 참고', body: ['독자의 드라이버와 거리가 먼 변화와 목록성 자료입니다. 필요한 것만 펼쳐 봅니다.', ...reference].join('\n\n') });
  }

  // 점검 명령은 줄이지 않는다: 위 표에서 뺀 이름까지 모두 넣어야 "안 나오면 안 걸린다"가 성립한다.
  const usedNames = new Set(used.map((e) => e.name));
  const sigNames = [...new Set(areaRows.filter((r) => r.kind !== 'member' && !(r.kind === 'export' && r.change === 'changed') && !usedNames.has(r.name)).map((r) => r.name))];
  const structNames = [...new Set(areaRows.filter((r) => r.kind === 'member').map((r) => r.struct))];
  const grepList = (title, list) => (list.length ? `# ${title} ${list.length}개\ngit grep -nwF -f - <<'EOF'\n${list.join('\n')}\nEOF` : '');
  const commands = [
    grepList('사라진 API', [...usedNames]),
    grepList('중점 영역에서 바뀌거나 사라진 API', sigNames),
    grepList('멤버가 바뀌거나 사라진 구조체', structNames),
    grepList('라이선스·네임스페이스가 바뀐 export', data.exports.changed.map((c) => c.name)),
    driverKconfig.length ? `# 사라진 드라이버 Kconfig 심볼 ${driverKconfig.length}개\ngrep -rnwE '(CONFIG_)?(${driverKconfig.map((k) => k.name).join('|')})' --include='Kconfig*' --include='Makefile' --include='*defconfig' .` : '',
  ].filter(Boolean);
  if (commands.length) {
    sections.push({
      heading: '내 드라이버 점검 명령',
      body: [
        '드라이버 소스 디렉터리(git 저장소)에서 실행하면 이 글이 다룬 이름을 쓰는 곳을 찾습니다. 위 표에서 뺀 이름까지 모두 들어 있습니다. '
          + '아무것도 나오지 않으면 이 목록에는 걸리지 않습니다. 이 글이 보지 않는 헤더의 시그니처 변경은 잡지 못하므로 빌드로 마저 확인합니다.',
        fold('명령 펼치기', `\`\`\`sh\n${commands.join('\n')}\n\`\`\``),
      ].join('\n\n'),
    });
  }

  const topNames = new Set(top.map((r) => r.name));
  const focusCount = inFocus.size;
  // 출처는 펼쳐 보이는 항목이 기댄 pull 만: 독자와 가까운 pull 과, 위쪽 두 섹션에 항목이 나온 영역의 pull.
  const openAreas = new Set([...top, ...generic].map((r) => r.area).filter(Boolean));
  const cited = [...input.pulls.filter((p) => active && p.mine), ...[...openAreas].flatMap((a) => a.pulls.map((p) => pullById.get(shortSha(p.sha)))).filter(Boolean)];
  const sources = (cited.length ? cited : input.pulls.slice(0, 10)).filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
  return {
    id: lts ? `${kstDate(toDate)}-linux-${from}-${to}-lts-driver-impact` : `${kstDate(toDate)}-linux-${to}-driver-impact`,
    topic: 'linux-driver-impact',
    title: lts ? `Linux ${from.replace(/^v/, '')} → ${version} LTS 드라이버 영향 노트` : `Linux ${version} 드라이버 영향 노트`,
    headline: notes.overview[0]?.text
      || (active ? `${label}: ${profile.title}에서 볼 변경 ${topNames.size}건` : `${label}: 드라이버 개발자가 확인할 변경`),
    date: kstDate(toDate),
    summary: `${label}: 커밋 ${commits}개, pull ${merges}개. `
      + (active ? `${profile.title}에서 볼 API 변경이 ${topNames.size}건, 여러 서브시스템이 쓰는 API 변경이 ${generic.length}건입니다. ` : '')
      + `트리 전체로는 드라이버가 쓰던 API ${used.length}개와 드라이버 Kconfig 심볼 ${driverKconfig.length}개가 사라졌고, `
      + `중점 영역에서 드라이버가 쓰던 API ${focusCount}개가 바뀌거나 사라졌습니다.`,
    tags: ['리눅스', '커널', '드라이버', ...(lts ? ['LTS', from] : []), to],
    sections,
    confidence: {
      level: '자동 생성',
      note: `${from}..${to} git 기록에서 코드가 뽑은 사실과, 그 커밋·pull 문구만 본 AI 요약입니다(웹 검색 없음). `
        + `사용 수는 ${from} drivers/·sound/에서 그 이름을 쓴 파일 수이고, 구조체 멤버는 타입을 확인하지 않은 상한값입니다.`
        + (active ? ' 어느 항목을 위에 둘지는 메인라인에 있는 같은 종류 드라이버의 사용처로 가른 근사치이고, 트리 밖 드라이버는 보지 않았습니다.' : ''),
    },
    sources: sources.map((p) => ({ title: p.title, url: commitUrl(p.id), note: 'merge' })),
    draftMetadata: {
      source: 'kernel-git',
      ...(lts ? { kind: 'lts' } : {}),
      range: `${from}..${to}`,
      ...(active ? { profile: profile.id } : {}),
      ai: notes.overview.length > 0 || notes.apiNotes.size > 0 || notes.subsystems.size > 0,
      counts: {
        commits, merges, focusChanges: focusCount, removedApis: apis.length, usedRemovedApis: used.length,
        ...(active ? { profileChanges: topNames.size } : {}), genericChanges: generic.length,
        exportChanges: data.exports.changed.length, driverKconfig: driverKconfig.length, campaigns: data.campaigns.length, broad: data.broad.length,
      },
    },
  };
}
