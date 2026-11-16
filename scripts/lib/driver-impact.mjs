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
 * 같은 이름을 스스로 `#define` 한 드라이버 파일을 찾는 `git grep -o -E` 패턴. 그 디렉터리의 사용은 사라진 매크로의 사용이 아니다:
 * v7.1 에서 지워진 ATM 의 `PRIV`, libsas 의 `to_dev_attr` 는 다른 드라이버들이 제각기 정의한 같은 이름 때문에 "21개·8개 파일이 사용"으로 나왔다.
 */
export function defineGrep(names) {
  const alt = [...new Set(names)].filter((n) => /^\w+$/.test(n)).join('|');
  return { pattern: alt ? `^[[:space:]]*#[[:space:]]*define[[:space:]]+(${alt})\\b` : '', name: (hit) => /(\w+)\s*$/.exec(hit)?.[1] || '' };
}

/**
 * 한 커밋의 `git show -U0` 출력에서, 이름마다 트리 안 드라이버의 호출부를 고친 작은 hunk 를 고른다 → Map(name → [{ file, before, after }]).
 * 들여쓴 줄(호출부)에 이름이 있고 지운 줄·더한 줄이 각각 1~3줄인 hunk 만 쓴다. 0열에서 시작하는 줄은 정의·선언이라 예시가 아니다.
 * 서브시스템이 다른 예를 perName 개까지 남기되 prefer(file) 가 참인 것(독자와 가까운 드라이버)을 앞에 둔다.
 */
export function fixExamples(diffText, names, { perName = 4, prefer = () => false } = {}) {
  const found = new Map(names.map((n) => [n, []]));
  const matchers = names.filter((n) => /^\w+$/.test(n)).map((n) => [n, new RegExp(`\\b${n}\\b`)]);
  const area = (f) => f.split('/').slice(0, 3).join('/');
  const clean = (l) => l.trim().replace(/\s+/g, ' ').slice(0, 160);
  let file = '';
  let minus = [];
  let plus = [];
  const flush = () => {
    if (file && minus.length && plus.length && minus.length <= 3 && plus.length <= 3) {
      for (const [name, re] of matchers) {
        const list = found.get(name);
        if (list.length < 200 && minus.some((l) => /^\s/.test(l) && !/^\s*(?:\*|\/\/|\/\*)/.test(l) && re.test(l))) list.push({ file, before: minus.map(clean), after: plus.map(clean) });
      }
    }
    minus = [];
    plus = [];
  };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); file = ''; }
    else if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    else if (line.startsWith('@@')) flush();
    else if (line[0] === '-') minus.push(line.slice(1));
    else if (line[0] === '+') plus.push(line.slice(1));
  }
  flush();
  const out = new Map();
  for (const [name, list] of found) {
    const picked = [];
    for (const e of [...list].sort((a, b) => Number(prefer(b.file)) - Number(prefer(a.file)))) {
      if (picked.length < perName && !picked.some((p) => area(p.file) === area(e.file))) picked.push(e);
    }
    out.set(name, picked);
  }
  return out;
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
  // 드라이버(벤더)가 정의한 것을 한 벤더의 드라이버만 쓰면 그 벤더 안의 연결이다(v6.18 `cmdq_pkt_finalize`: mediatek soc → mediatek mdp3,
  // v7.2 `tegra_powergate_power_off`: tegra soc → nvidia 미디어). 같은 종류라는 이유(proxy)로는 세지 않는다.
  // 내 플랫폼 경로의 드라이버가 썼다면 한 곳이어도 센다.
  // 벤더 코드: `drivers/<서브시스템>/<벤더>/…` 처럼 한 단계 더 들어간 곳과 `include/soc/`. 서브시스템 코어(`drivers/iommu/iommu.c`,
  // `drivers/media/v4l2-core/`)는 벤더 코드가 아니라서, 미디어 드라이버 한 곳만 써도 센다.
  const file = item.file || '';
  const vendorDefined = /^include\/soc\//.test(file)
    || (DRIVER_PATH_RE.test(file) && file.split('/').length >= 4 && !/\/(?:[\w-]*core|common)\//.test(file));
  const vendors = (files) => new Set(files.map((f) => f.split('/').slice(0, 4).join('/'))).size;
  const groups = profile.groups
    .map((g) => {
      const hit = users.filter((f) => g.paths.test(f));
      return { id: g.id, label: g.label, count: g.proxy && vendorDefined && vendors(hit) < 2 ? 0 : hit.length };
    })
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

// 같은 타입의 다른 표기는 변화가 아니다(v7.1 `parse_args` 의 `unsigned` → `unsigned int` 가 시그니처 변경으로 나왔다).
const sameSpelling = (s) => s.replace(/\bunsigned(?! (?:int|long|short|char)\b)/g, 'unsigned int');
const tidy = (s) => sameSpelling((s.match(/[A-Za-z_]\w*|\.\.\.|\S/g) || []).join(' ').replace(/\* (?=\*)/g, '*'));

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
  return sameSpelling(tokens.join(' ').replace(/\* (?=\*)/g, '*')) + (arr ? '[]' : '');
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

/**
 * 수집 결과 형식 판. 다르면 다시 수집한다.
 * 2: 이름마다 사용 파일(users)을, 전환마다 건드린 디렉터리(dirNames)를 남긴다.
 * 3: 이름마다 트리 안 드라이버를 고친 예(examples)를 남기고, 스스로 정의한 같은 이름의 매크로 사용은 세지 않는다.
 */
export const RAW_SCHEMA = 3;

const COMMIT_URL = 'https://git.kernel.org/torvalds/c/';
export const shortSha = (sha) => sha.slice(0, 12);
const commitUrl = (sha) => `${COMMIT_URL}${shortSha(sha)}`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const code = (s) => `\`${String(s).replace(/`/g, '')}\``;
const REMOVED_LABEL = { function: '함수 삭제', macro: '매크로 삭제', constant: '상수 삭제', variable: '변수 삭제', struct: '구조체 삭제', member: '멤버 삭제', export: 'export 해제' };
const CHANGED_LABEL = { function: '시그니처 변경', macro: '매크로 인자 수 변경', variable: '타입 변경', member: '멤버 타입 변경', export: 'export 변경' };
const byUse = (a, b) => (b.driverUses ?? 0) - (a.driverUses ?? 0) || a.name.localeCompare(b.name);
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
  const examples = new Map([...data.exports.removed, ...data.headers].filter((e) => e.examples).map((e) => [e.name, e.examples]));
  const taken = new Set();
  return areaDefs(profile).map((area) => {
    const found = (data.focus || []).find((f) => f.id === area.id) || { files: 0, items: [] };
    const exportRows = [
      ...data.exports.removed.filter((e) => area.sources.test(e.file) && e.header !== 'inline' && e.driverUses > 0)
        .map((e) => ({ change: 'removed', kind: 'export', name: e.name, before: e.kind, declared: e.header === 'declared', driverUses: e.driverUses, users: e.users, file: e.file, commit: e.commit })),
      ...data.exports.changed.filter((c) => area.sources.test(c.file))
        .map((c) => ({ change: 'changed', kind: 'export', name: c.name, before: c.from, after: c.to, driverUses: c.users ? c.users.length : null, users: c.users, file: c.file, commit: null })),
    ];
    const rows = [...found.items.filter((i) => i.change !== 'added'), ...exportRows]
      .map((r) => ({ ...r, ...(r.change === 'removed' && renamed.get(r.name) ? { renamedTo: renamed.get(r.name) } : {}), ...(!r.examples && examples.get(r.name) ? { examples: examples.get(r.name) } : {}) }))
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

// ── 모듈: 글에서 표를 나누는 단위 ──────────────────────────────────────────

/**
 * 글에서 표 하나가 되는 단위. 헤더·소스 경로로 가르며 중점 영역보다 잘다("메모리·DMA" → 메모리, DMA·dma-buf).
 * 배열 순서가 글의 순서이고, 앞에서 먼저 걸린 모듈로 간다(`drivers/base/regmap` 은 디바이스 모델이 아니라 regmap).
 */
export const MODULES = [
  { id: 'v4l2', title: 'V4L2', paths: /^(?:include\/media\/(?:v4l2-|media-|mipi-csi2)|drivers\/media\/(?:v4l2-core|mc)\/)/ },
  { id: 'vb2', title: 'videobuf2', paths: /^(?:include\/media\/videobuf2-|drivers\/media\/common\/videobuf2\/)/ },
  { id: 'media', title: '미디어 기타', paths: /^(?:include\/media\/|drivers\/media\/)/ },
  { id: 'samsung', title: 'Samsung SoC', paths: /^(?:include\/linux\/(?:soc|mfd|firmware|clk)\/samsung|include\/linux\/clk\/samsung\.h|drivers\/(?:soc|firmware|clk|pinctrl|phy|pmdomain)\/samsung\/)/ },
  { id: 'dma', title: 'DMA·dma-buf', paths: /^(?:include\/linux\/(?:dma-|dmapool|scatterlist|cma\.h)|kernel\/dma\/|drivers\/dma-buf\/|lib\/scatterlist)/ },
  { id: 'mm', title: '메모리', paths: /^(?:include\/linux\/(?:mm[._]|mmzone|mmap_lock|gfp|slab|vmalloc|highmem|page|memremap|mempool|huge_mm|io-mapping|uaccess)|mm\/)/ },
  { id: 'i2c', title: 'I2C', paths: /^(?:include\/linux\/i2c[.\-/]|drivers\/i2c\/)/ },
  { id: 'spi', title: 'SPI·I3C', paths: /^(?:include\/linux\/(?:spi|i3c)\/|drivers\/(?:spi|i3c)\/)/ },
  { id: 'gpio', title: 'GPIO', paths: /^(?:include\/linux\/gpio[./]|drivers\/gpio\/)/ },
  { id: 'clk', title: 'clk', paths: /^(?:include\/linux\/clk[.\-/]|drivers\/clk\/)/ },
  { id: 'regulator', title: 'regulator', paths: /^(?:include\/linux\/regulator\/|drivers\/regulator\/)/ },
  { id: 'pinctrl', title: 'pinctrl', paths: /^(?:include\/linux\/pinctrl\/|drivers\/pinctrl\/)/ },
  { id: 'regmap', title: 'regmap·reset', paths: /^(?:include\/linux\/(?:regmap\.h|reset[.\-/])|drivers\/(?:base\/regmap|reset)\/)/ },
  { id: 'phy', title: 'PHY', paths: /^(?:include\/linux\/phy\/|drivers\/phy\/)/ },
  { id: 'iommu', title: 'IOMMU', paths: /^(?:include\/linux\/(?:iommu[.\-]|iova|io-pgtable)|drivers\/iommu\/)/ },
  { id: 'pm', title: '전원(PM)', paths: /^(?:include\/linux\/(?:pm[._]|devfreq|interconnect|thermal)|drivers\/(?:pmdomain|opp|devfreq|interconnect|thermal|base\/power)\/)/ },
  { id: 'device', title: '디바이스 모델', paths: /^(?:include\/linux\/(?:device[./]|platform_device|property\.h|fwnode|of[._]|firmware\.h|devm-helpers|mod_devicetable|module\.h|moduleparam|kobject|sysfs)|drivers\/(?:base|of)\/)/ },
  { id: 'irq', title: '인터럽트', paths: /^(?:include\/linux\/(?:interrupt\.h|irq|msi)|kernel\/irq\/)/ },
  { id: 'timer', title: '타이머', paths: /^(?:include\/linux\/(?:timer|hrtimer|jiffies|ktime|timekeeping|delay\.h|clockchips|clocksource|time64|alarmtimer)|kernel\/time\/)/ },
  { id: 'wq', title: 'workqueue', paths: /^(?:include\/linux\/workqueue|kernel\/workqueue)/ },
  { id: 'sched', title: '스케줄러·kthread', paths: /^(?:include\/linux\/(?:sched[./]|kthread|wait|swait|completion|preempt|smp\.h|cpumask)|kernel\/(?:sched\/|kthread|smp))/ },
  { id: 'lock', title: '락·RCU', paths: /^(?:include\/linux\/(?:mutex|spinlock|rwlock|rwsem|rcu|srcu|seqlock|refcount|kref|lockdep|cleanup|local_lock|llist)|kernel\/(?:locking|rcu)\/)/ },
];
const OTHER_MODULE = { id: 'etc', title: '그 밖의 API' };
export const moduleOf = (file) => MODULES.find((m) => m.paths.test(file || '')) || OTHER_MODULE;

// ── 영향: 호출·구현 쪽 코드가 그대로 빌드되는지를 시그니처만으로 가른다 ─────────────

/** "ret name(p1, p2)" 나 콜백 타입 "ret (*)(p1, p2)" → { ret, params }. 꼴이 다르면 null. */
function splitSig(sig, name = '') {
  if (!sig) return null;
  // 함수는 이름 바로 뒤의 괄호가 인자 목록이다(인자에 함수 포인터가 있어도 헷갈리지 않게 이름으로 찾는다).
  const at = name ? sig.indexOf(`${name}(`) : -1;
  const callback = at < 0 ? sig.indexOf('(*)') : -1;
  const open = at >= 0 ? at + name.length : callback >= 0 ? sig.indexOf('(', callback + 3) : -1;
  if (open < 0) return null;
  return { ret: sig.slice(0, at >= 0 ? at : callback).trim(), params: splitTop(sig.slice(open + 1, closeOf(sig, open) - 1), ',') };
}

/** 두 배열의 최장 공통 부분열에 든 원소 표시 → [a 쪽, b 쪽]. 표시되지 않은 것이 지워지거나 더해진 것이다. */
function commonMarks(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const ka = new Array(a.length).fill(false);
  const kb = new Array(b.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { ka[i] = true; kb[j] = true; i += 1; j += 1; } else if (t[i + 1][j] >= t[i][j + 1]) i += 1; else j += 1;
  }
  return [ka, kb];
}

const typeTokens = (s) => s.match(/[A-Za-z_]\w*|\.\.\.|\S/g) || [];

/**
 * 인자 타입이 const 만 더했고, 그 const 가 바깥 포인터가 가리키는 타입에 붙었는지(`T *` → `const T *`, `T **` → `T * const *`).
 * C 는 이 자리의 한정자 추가만 암묵 변환으로 받는다. 더 안쪽(`T **` → `const T **`)은 호출 쪽에서 오류다.
 */
function addsOuterConst(before, after) {
  const [a, b] = [typeTokens(before), typeTokens(after)];
  const [ka, kb] = commonMarks(a, b);
  const added = b.flatMap((t, i) => (kb[i] ? [] : [[t, i]]));
  return !ka.includes(false) && added.length > 0 && added.every(([t, i]) => t === 'const' && b.slice(i).filter((x) => x === '*').length <= 1);
}

/** 값으로 넘기는 숫자형(`int`, `bool`, `u32`, `size_t` …). 숫자형끼리 바뀐 인자는 넘기던 값이 암묵 변환되어 호출부가 그대로 빌드된다. */
const isScalar = (type) => { const t = typeTokens(type).filter((x) => x !== 'const'); return t.length > 0 && t.every((x) => TYPE_WORDS.has(x) && x !== 'void'); };

/**
 * 변화 하나의 영향. break: 쓰고 있으면 빌드가 깨진다. ok: 기존 코드가 그대로 빌드된다. check: 시그니처만으로는 가를 수 없다.
 * - 삭제, 인자 수·타입 변경, 콜백 멤버의 타입 변경(구현 함수의 타입이 맞아야 한다)은 break
 * - 반환형만 `void` → 값·`int` → `bool` 로 바뀌었거나 인자에 바깥 const 만 붙었거나 숫자형 인자가 다른 숫자형이 된 함수
 *   (v7.3 `smp_call_function_single()` 의 `int` → `bool`), 바깥 const 만 붙은 멤버는 ok
 * - 콜백이 아닌 멤버의 타입, 그 밖의 반환형, 인자에서 const 가 빠진 것, export 의 라이선스·네임스페이스는 check
 * AI 는 이 판정에 끼지 않는다. v6.18 `v4l2_ctrl_handler_free()`(void → int)를 AI 가 "반환값을 받도록 고친다"로 썼다.
 */
export function impactOf(r) {
  if (r.change === 'removed') return 'break';
  if (r.kind === 'macro') return 'break';
  if (r.kind === 'member') return /\(\*\)/.test(`${r.before} ${r.after}`) ? 'break' : addsOuterConst(r.before || '', r.after || '') ? 'ok' : 'check';
  if (r.kind !== 'function') return 'check';
  const [was, now] = [splitSig(r.before, r.name), splitSig(r.after, r.name)];
  if (!was || !now) return 'check';
  if (was.params.length !== now.params.length) return 'break';
  let level = was.ret === now.ret || was.ret === 'void' || (was.ret === 'int' && now.ret === 'bool') ? 'ok' : 'check';
  for (const [i, p] of was.params.entries()) {
    if (p === now.params[i] || addsOuterConst(p, now.params[i]) || (isScalar(p) && isScalar(now.params[i]))) continue;
    if (!addsOuterConst(now.params[i], p)) return 'break';
    level = 'check'; // const 가 빠졌다: const 포인터를 넘기던 호출만 깨진다
  }
  return level;
}

/**
 * 수집 결과를 글이 쓰는 변화 목록으로. rows 마다 module·impact·rel 이 붙는다.
 * visible: 독자와 가까운 것(프로필의 주 영역이거나 프로필 경로의 드라이버가 쓰던 것)과 여러 서브시스템이 쓰는 것. 표로 펼친다.
 * other: 다른 서브시스템 안에서만 쓰이던 것. 접어 둔다. 한 이름은 둘 중 한 곳에만 있다.
 */
function classify(data, profile) {
  const active = profileActive(profile);
  const areas = focusAreas(data, profile);
  const areaRows = areas.flatMap((a) => a.rows.map((r) => ({ ...r, area: a })));
  const inFocus = new Set(areaRows.map((r) => r.name));
  const loose = removedApis(data).filter((e) => e.driverUses > 0 && !inFocus.has(e.name))
    .map((e) => ({ ...e, change: 'removed', loose: true, renamedTo: e.commit?.renamedTo, rel: relevance(e, profile) }));
  const near = (r) => active && (Boolean(r.area?.primary) || r.rel.tier === 'mine');
  const rows = [...areaRows, ...loose].map((r) => ({ ...r, near: near(r), module: moduleOf(r.file), impact: impactOf(r) }));
  const visible = rows.filter((r) => r.near || r.rel.tier === 'generic');
  return { active, areas, rows, visible, other: rows.filter((r) => !visible.includes(r)) };
}

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
 * AI 에 넘길 입력. 표에 펼치는 변화(visible) 전부와 그 커밋 글을 준다: AI 는 이름마다 "왜 바뀌었고 무엇을 하면 되는지"를 쓴다.
 * 접어 두는 변화는 주지 않는다. pull 은 독자와 가까운 것, 바뀐 영역의 것, 드라이버를 많이 바꾼 것 순으로 조금만 준다.
 * messages 는 깨지는 변화의 커밋부터 messageChars 까지만 본문을 싣고, 넘치면 제목만 준다.
 */
export function buildAiInput(data, profile = compileProfile(), { maxPulls = 12, areaPulls = 2, summaryChars = 2500, otherSummaryChars = 1200, messageChars = 120000 } = {}) {
  const { active, areas, visible } = classify(data, profile);
  const flag = (yes) => (yes ? { mine: true } : {});
  const brief = (r) => ({
    name: r.name, kind: r.kind, change: r.change, ...(r.before ? { before: r.before } : {}), ...(r.after ? { after: r.after } : {}),
    ...(r.renamedTo ? { renamedTo: r.renamedTo } : {}), impact: r.impact, commit: r.commit ? shortSha(r.commit.sha) : null, ...flag(r.near),
  });
  // 영역 pull 은 표에 변화가 나온 영역에서 드라이버를 많이 건드린 순으로 areaPulls 개만(LTS 구간은 영역마다 릴리스 수만큼 있다).
  const shownIn = (a) => visible.some((r) => r.area === a);
  const areaPull = (a) => (shownIn(a) ? [...a.pulls].sort((x, y) => y.driverFiles - x.driverFiles).slice(0, areaPulls) : []);
  const focus = areas.map((a) => ({
    id: a.id,
    title: a.title,
    changes: visible.filter((r) => r.area === a).map(brief),
    pulls: areaPull(a).map((p) => shortSha(p.sha)),
    ...(Object.keys(a.same).length ? { unchangedMembers: a.same } : {}),
  }));
  const apiRemovals = visible.filter((r) => r.loose).map(brief);

  const byTag = (p) => profile.pullTags.test(p.tag || '');
  const minePull = (p) => active && !isFixPull(p) && (byTag(p) || profile.pullKeywords.test(p.summary || ''));
  const minePulls = data.pulls.filter(minePull).sort((a, b) => Number(byTag(b)) - Number(byTag(a)) || b.driverFiles - a.driverFiles).slice(0, 10);
  const focusPulls = new Set(areas.flatMap((a) => areaPull(a).map((p) => p.sha)));
  const pulls = [
    ...minePulls,
    ...data.pulls.filter((p) => focusPulls.has(p.sha)),
    ...data.pulls.filter((p) => isDriverPull(p) && !/\bfix(?:es)?\b/i.test(p.title)).sort((a, b) => b.driverFiles - a.driverFiles).slice(0, maxPulls),
  ].filter((p, i, all) => all.findIndex((q) => q.sha === p.sha) === i).map((p) => {
    const mine = minePulls.includes(p);
    // 키워드로만 걸린 pull 은 그 키워드가 나온 대목만 준다(clk pull 전체가 아니라 Samsung 대목).
    const summary = mine && !byTag(p) ? keywordExcerpt(p.summary, profile.pullKeywords) : p.summary.slice(0, mine ? summaryChars : otherSummaryChars);
    return { id: shortSha(p.sha), title: p.title, summary, ...flag(mine) };
  });

  // 커밋 제목도 함께 준다: "Rename a() to b()" 처럼 대체 이름이 제목에만 있는 커밋이 많다.
  const weight = { break: 0, check: 1, ok: 2 };
  const cited = [...new Set([...visible].filter((r) => r.commit).sort((a, b) => weight[a.impact] - weight[b.impact]).map((r) => r.commit.sha))];
  const subjects = new Map(visible.filter((r) => r.commit?.subject).map((r) => [r.commit.sha, r.commit.subject]));
  let budget = messageChars;
  const messages = Object.fromEntries(cited.map((sha) => {
    const body = budget > 0 ? data.messages[sha] : undefined;
    budget -= body?.length || 0;
    return [shortSha(sha), [subjects.get(sha), body].filter(Boolean).join('\n\n')];
  }).filter(([, text]) => text));
  return { range: { from: data.range.from, to: data.range.to }, ...(profile.reader ? { reader: profile.reader } : {}), focus, pulls, apiRemovals, messages };
}

/**
 * 변화가 많은 범위(LTS)는 AI 호출을 나눈다 → 입력 조각들. 조각마다 이름 size 개 안팎과 그 커밋 글만 들고, pull 은 첫 조각에만 준다.
 * 조각의 답을 합쳐 전체 입력으로 cleanNotes 를 돌린다.
 */
export function splitAiInput(input, size = 40) {
  const names = [...input.focus.flatMap((f) => f.changes), ...input.apiRemovals].map((c) => c.name);
  if (names.length <= size) return [input];
  const parts = [];
  for (let at = 0; at < names.length; at += size) {
    const part = new Set(names.slice(at, at + size));
    const focus = input.focus.map((f) => ({ ...f, changes: f.changes.filter((c) => part.has(c.name)), pulls: at === 0 ? f.pulls : [] })).filter((f) => f.changes.length);
    const apiRemovals = input.apiRemovals.filter((c) => part.has(c.name));
    const cited = new Set([...focus.flatMap((f) => f.changes), ...apiRemovals].map((c) => c.commit));
    parts.push({ ...input, focus, apiRemovals, pulls: at === 0 ? input.pulls : [], messages: Object.fromEntries(Object.entries(input.messages).filter(([id]) => cited.has(id))) });
  }
  return parts;
}

// 영문 사이에 한글이 끼어든 토큰("fl사/eject")과 한자·가나는 모델 출력이 깨진 흔적이다.
const GARBLED_RE = /[A-Za-z][가-힣]{1,2}[A-Za-z/]|[぀-ヿ一-鿿]/;
// 입력 JSON 필드 이름이 글에 새면 안 된다.
const INPUT_FIELD_RE = /\b(?:unchangedMembers|apiRemovals|driverUses|renamedTo|apiNotes)\b/;
// 입력에 없는 영향·할 일을 덧붙인 문장. v7.3 글의 "GPIOLIB_LEGACY 선택이 필요한 조합이 생겼다"(실제로는 def_bool y)처럼
// pull 요약을 부풀린 문장이 읽는 사람에게 "빌드가 깨진다"로 전해졌다. 사실은 표에 남으므로 문장만 버린다.
const SPECULATION_RE = /영향을 (?:줄|미칠) 수 있|점검한다|점검해야|점검이 필요|확인이 필요/;
// 글이 아니라 입력을 가리키는 말(v7.3: "메시지에 적힌 대로 `delay_read_timer`를 쓴다"). 독자는 그 "메시지"를 보지 못한다.
const META_RE = /메시지에 (?:적힌|따르면)|메시지대로|요약에 (?:적힌|따르면)|입력(?:에 |된 | JSON)/;
// 기존 코드가 그대로 빌드되는 변화(impact ok)를 "고쳐야 한다"고 쓴 문장.
const MUST_FIX_RE = /고친다|고쳐야|맞춘다|맞춰야|수정한다|수정해야|받도록/;

/**
 * AI 출력에서 입력에 있는 id·이름을 가리키는 항목만 남긴다. 길이를 넘기거나 URL 을 넣었거나,
 * 백틱으로 감싼 이름이 입력에 없거나, 글자가 깨졌거나, 입력에 없는 영향·할 일을 덧붙였거나, 입력 자체를 가리키거나,
 * 그대로 빌드되는 변화를 고치라고 쓴 항목은 버린다.
 * 반환: { notes: { apiNotes: Map(name → 문장), subsystems: Map(pull id → 문장들) }, dropped } — dropped 는 버린 항목 수.
 */
export function cleanNotes(raw, input) {
  const pullIds = new Set(input.pulls.map((p) => p.id));
  const changes = [...(input.focus || []).flatMap((f) => f.changes), ...input.apiRemovals];
  const apiNames = new Set(changes.map((c) => c.name));
  // 이름 변경 후보(renamedTo)는 "같은 커밋이 이름 하나를 더했다"는 추정이라 근거로 치지 않는다. 커밋 제목·본문이나
  // pull 요약에 그 이름이 있어야 "대신 쓴다"고 쓸 수 있다(v7.4-rc1 `fd_prepare_fd` → `__FD_PREPARE` 는 대체가 아니었다).
  const haystack = JSON.stringify(input, (key, value) => (key === 'renamedTo' ? undefined : value));
  const harmless = new Set(changes.filter((c) => c.impact === 'ok').map((c) => c.name));
  const ticked = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\(\)$/, ''));
  const grounded = (s) => ticked(s).every((t) => haystack.includes(t.split('*')[0]));
  // 헤더 비교로 그대로인 멤버를, 같은 구조체의 타입이 바뀐 멤버와 함께 바뀌었다고 쓴 문장(요약·커밋 메시지를 따른 오류).
  // 지워진 멤버에는 대지 않는다: "`offline`을 `flags`로 옮겼다"는 그대로인 멤버를 옮겨 간 곳으로 든 것이다(v7.2 `device.offline`).
  const sameMembers = (input.focus || []).flatMap((f) => Object.entries(f.unchangedMembers || {}).map(([struct, same]) => ({
    same: new Set(same), changed: f.changes.filter((c) => c.change === 'changed' && c.name.startsWith(`${struct}.`)).map((c) => c.name.slice(struct.length + 1)),
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
  // 대체 이름만 달랑 준 답("delay_read_timer")은 문장 꼴로 바꾼다. 백틱이 붙으므로 다른 문장과 똑같이 근거를 검사한다.
  const note = (s) => {
    const bare = /^`?([A-Za-z_]\w*)(?:\(\))?`?\.?$/.exec(typeof s === 'string' ? s.trim() : '');
    return text(bare ? `대신 쓸 것: \`${bare[1]}\`` : s, 300);
  };
  let dropped = 0;
  const keep = (list, fn) => (Array.isArray(list) ? list : []).flatMap((item) => {
    const value = item && typeof item === 'object' ? fn(item) : null;
    if (!value) dropped += 1;
    return value ? [value] : [];
  });
  const notes = {
    apiNotes: new Map(keep(raw.apiNotes, (n) => {
      const t = note(n.note ?? n.replacement);
      return apiNames.has(n.name) && t && !(harmless.has(n.name) && MUST_FIX_RE.test(t)) ? [n.name, t] : null;
    })),
    subsystems: new Map(keep(raw.subsystems, (s) => {
      const points = (Array.isArray(s.points) ? s.points : []).map((p) => text(p, 400)).filter(Boolean).slice(0, 4);
      return pullIds.has(s.id) && points.length ? [s.id, points] : null;
    })),
  };
  return { notes, dropped };
}

const EMPTY_NOTES = { apiNotes: new Map(), subsystems: new Map() };

function kstDate(iso) {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ── 표의 칸: 바뀐 부분만 굵게, 긴 시그니처는 그대로인 인자를 줄인다 ──────────────────

// 표의 칸은 HTML 로 쓴다(코드 안에서 굵은 글씨를 쓰려고). 마크다운이 `*`·`_`·`|` 를 문법으로 읽지 않게 문자 참조로 바꾼다.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*_|`[\]~\\]/g, (c) => `&#${c.charCodeAt(0)};`);
const mono = (html) => `<code>${html}</code>`;
const strong = (s) => `<b>${esc(s)}</b>`;
const SIG_LIMIT = 72; // 이보다 긴 인자 목록은 그대로인 인자를 … 로 줄인다

/** 인자 목록. keep[i] 가 거짓인 인자(지워지거나 더해진 것)는 굵게, 길면 그대로인 인자의 연속을 … 하나로. */
function paramsHtml(params, keep) {
  const elide = params.join(', ').length > SIG_LIMIT;
  const out = [];
  for (const [i, p] of params.entries()) {
    if (!keep[i]) out.push(strong(p));
    else if (!elide) out.push(esc(p));
    else if (out.at(-1) !== '…') out.push('…');
  }
  return out.join(', ');
}

/** 타입 문자열 두 개에서 서로 다른 토큰만 굵게 → [이전, 이후]. */
function typeDiffHtml(before, after) {
  const [a, b] = [typeTokens(before), typeTokens(after)];
  const [ka, kb] = commonMarks(a, b);
  // 토큰 사이는 띄우되 괄호·대괄호 안쪽과 쉼표 앞은 붙인다(`struct tunertype[]`, `int (*)(void)`).
  const join = (tokens, keep) => tokens.map((t, i) => `${i > 0 && !/^[\])[,]$/.test(t) && !/^[[(]$/.test(tokens[i - 1]) && !(t === '[' || t === '(' && tokens[i - 1] === ')') ? ' ' : ''}${keep[i] ? esc(t) : strong(t)}`).join('');
  return [join(a, ka), join(b, kb)];
}

const displayName = (r) => (r.kind === 'member' ? `${r.struct}.${r.member}` : r.name);
const macroArgs = (s) => (s === '(...)' ? '가변 인자' : /^\(\d+\)$/.test(s || '') ? `인자 ${s.slice(1, -1)}개` : '');

/**
 * 호출부 예시에서 읽은 새 이름. 그 이름만 다른 이름으로 바꾼 줄들이 모두 같은 이름으로 바꿨고, 고친 뒤에 옛 이름을 부르는 예가 없으면 그 이름이다.
 * 같은 커밋이 더한 이름(renamedTo)만으로는 대체라고 하지 않는다(v7.4-rc1 `fd_prepare_fd` → `__FD_PREPARE` 는 대체가 아니었다).
 */
export function renamedInExamples(r) {
  const tokens = (l) => l.match(/[A-Za-z_]\w*|\S/g) || [];
  const found = new Set();
  for (const e of r.examples || []) {
    if (e.after.some((l) => tokens(l).includes(r.name))) return null; // 고친 뒤에도 그 이름을 부른다: 이름이 바뀐 것이 아니다
    if (e.before.length !== 1 || e.after.length !== 1) continue;
    const [a, b] = [tokens(e.before[0]), tokens(e.after[0])];
    const diff = a.length === b.length ? a.flatMap((t, i) => (t === b[i] ? [] : [[t, b[i]]])) : [];
    if (diff.length && diff.every(([was, now]) => was === r.name && /^[A-Za-z_]\w*$/.test(now))) found.add(diff[0][1]); // 그 이름만 다른 이름으로 바꾼 줄
  }
  return found.size === 1 ? [...found][0] : null;
}

/** 변화 하나의 [기존 칸, 변경 칸] (HTML). */
function cells(r) {
  const name = displayName(r);
  const looseExport = r.loose && /^export/.test(r.kind);
  if (r.change === 'removed') {
    const renamed = renamedInExamples(r);
    const sig = splitSig(r.before, r.name);
    const callable = r.kind === 'function' || (r.kind === 'macro' && r.before !== '') || (r.kind === 'member' && /\(\*\)/.test(r.before || ''));
    let before = mono(`${esc(name)}${callable ? `(${sig && r.kind === 'function' ? paramsHtml(sig.params, sig.params.map(() => true)) : ''})` : ''}`);
    if (r.kind === 'struct') before = mono(`struct ${esc(name)}`);
    if (r.kind === 'export' || looseExport) before = `${mono(esc(name))} export`;
    const gone = r.kind === 'export' || looseExport ? `export 해제${r.declared || /선언은 남음/.test(r.kind) ? '(선언만 남음)' : ''}` : '삭제';
    return [before, renamed ? mono(`${strong(renamed)}${callable ? '()' : ''}`) : gone];
  }
  if (r.kind === 'function' || (r.kind === 'member' && /\(\*\)/.test(`${r.before}${r.after}`))) {
    const [was, now] = [splitSig(r.before, r.name), splitSig(r.after, r.name)];
    if (was && now) {
      const [ka, kb] = commonMarks(was.params, now.params);
      const ret = (side, other) => (side.ret !== other.ret && side.ret ? `${strong(side.ret)} ` : '');
      return [mono(`${ret(was, now)}${esc(name)}(${paramsHtml(was.params, ka)})`), mono(`${ret(now, was)}${esc(name)}(${paramsHtml(now.params, kb)})`)];
    }
  }
  if (r.kind === 'macro') return [mono(`${esc(name)}(${macroArgs(r.before)})`), mono(`${esc(name)}(${strong(macroArgs(r.after))})`)];
  const [was, now] = typeDiffHtml(r.before || '', r.after || '');
  return r.kind === 'export' ? [`${mono(esc(name))} ${mono(was)}`, mono(now)] : [`${mono(esc(name))}: ${mono(was)}`, mono(now)];
}

/** 같은 변경을 여러 이름에 되풀이한 것을 한 행으로 묶는 열쇠. 같은 커밋의 같은 차이(더하고 뺀 인자, 반환형)만 묶는다. */
function mergeKey(r) {
  const sha = r.commit?.sha;
  if (!sha) return null;
  if (r.change === 'removed') return r.kind === 'member' ? `${sha}|gone|${r.struct}` : renamedInExamples(r) ? null : `${sha}|gone`;
  const [was, now] = [splitSig(r.before, r.name), splitSig(r.after, r.name)];
  if (r.kind === 'function' || (r.kind === 'member' && was && now && /\(\*\)/.test(`${r.before}${r.after}`))) {
    if (!was || !now) return null;
    const [ka, kb] = commonMarks(was.params, now.params);
    const diff = [was.ret === now.ret ? '' : `${was.ret}>${now.ret}`, was.params.filter((_, i) => !ka[i]).join(';'), now.params.filter((_, i) => !kb[i]).join(';')].join('|');
    return `${sha}|${r.kind}|${r.struct || ''}|${diff}`;
  }
  return r.kind === 'member' ? `${sha}|type|${r.struct}|${r.before}>${r.after}` : null;
}

// 오타·링크·담당자 변경처럼 드라이버가 따라 할 것이 없는 문서 커밋.
const DOC_NOISE_RE = /typo|spelling|grammar|word order|dead link|\burl\b|maintainer|kernel-?doc|whitespace|copyright|spdx/i;
const TABLE_CAP = 50;
const FOLD_OK_OVER = 30; // 표에 펼칠 변화가 이보다 많은 글(LTS)은 그대로 빌드되는 것을 모듈마다 접는다
const IMPACT = { break: '**빌드&nbsp;실패**', check: '확인&nbsp;필요', ok: '그대로&nbsp;빌드' };
const IMPACT_ORDER = { break: 0, check: 1, ok: 2 };

/** 접어 두는 블록. 사이트 렌더러(marked)는 HTML 블록 안의 빈 줄 뒤 마크다운을 그대로 렌더링한다. */
const fold = (title, body) => `<details>\n<summary><strong>${title}</strong></summary>\n\n${body}\n\n</details>`;

/**
 * 수집 사실 + (있으면) AI 설명 → Dev Blog 글 JSON. 표·명령·링크·영향 판정은 모두 코드가 만든다.
 * 본문은 모듈마다 표 하나(영향 | 기존 | 변경 | 주요 설명)다. 설명문은 두지 않는다: 무엇을 기준으로 골랐는지는 confidence 에만 적는다.
 * 독자와 먼 변화와 목록성 자료는 맨 아래에 접는다. 한 이름은 한 곳에만 나온다.
 * lts: LTS → 다음 LTS 노트. 같은 끝 버전의 일반 노트와 id·제목이 겹치지 않고 draftMetadata.kind 로 구분한다.
 */
export function buildPost(data, input, notes = EMPTY_NOTES, { lts = false, profile = compileProfile() } = {}) {
  const { from, to, toDate, commits, merges } = data.range;
  const version = to.replace(/^v/, '');
  const label = lts ? `LTS ${from} → LTS ${to}` : `${from} → ${to}`;
  const { active, areas, rows, visible, other } = classify(data, profile);
  const apis = removedApis(data);
  const used = apis.filter((e) => e.driverUses > 0);
  const driverKconfig = data.kconfig.removed.filter((k) => /^(?:drivers|sound)\//.test(k.file))
    .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const commitLink = (c, text = '커밋') => (c ? `[${cell(text)}](${commitUrl(c.sha)})` : '');

  // 행: 같은 변경을 되풀이한 이름은 묶는다. 같은 커밋이 지운 이름은 셋 이상일 때만(둘은 따로 보는 편이 읽기 쉽다).
  const toViews = (list) => {
    const groups = new Map();
    const order = [];
    for (const r of list) {
      const key = mergeKey(r);
      if (key && groups.has(key)) groups.get(key).push(r);
      else { const g = [r]; if (key) groups.set(key, g); order.push(g); }
    }
    return order.flatMap((g) => (g.length === 2 && g[0].change === 'removed' && g[0].kind !== 'member' ? [[g[0]], [g[1]]] : [g])).map((g) => {
      const [first] = g;
      const [before, after] = cells(first);
      const more = g.slice(1).map((r) => mono(esc(r.kind === 'member' ? `.${r.member}` : r.name)));
      const others = more.length ? `<br>외 ${more.length}개: ${more.slice(0, 4).join(', ')}${more.length > 4 ? ' …' : ''}` : '';
      const said = g.map((r) => notes.apiNotes.get(r.name)).find(Boolean);
      const commit = g.find((r) => r.commit)?.commit;
      const note = said ? `${cell(said)}${commit ? ` ${commitLink(commit)}` : ''}` : commit ? commitLink(commit, commit.subject) : '—';
      return { rows: g, impact: g.map((r) => r.impact).sort((a, b) => IMPACT_ORDER[a] - IMPACT_ORDER[b])[0], before: `${before}${others}`, after, note };
    }).sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact]);
  };
  const table = (views) => ['| 영향 | 기존 | 변경 | 주요 설명 |', '|---|---|---|---|', ...views.map((v) => `| ${IMPACT[v.impact]} | ${v.before} | ${v.after} | ${v.note} |`)].join('\n');
  // 고친 예: 메인라인이 트리 안 드라이버의 호출부를 실제로 고친 줄. 수집기가 독자와 가까운 드라이버의 예를 앞에 둔다.
  // 같은 문장을 고친 hunk 만 쓴다: 지운 줄의 토큰 절반 이상이 더한 줄에 남아 있어야 한다(선언을 지우고 다른 변수를 더한 hunk 는 예시가 아니다).
  const words = (lines) => new Set(lines.join(' ').match(/[A-Za-z_]\w*/g) || []);
  const rewrites = (r) => (e) => {
    const was = [...words(e.before)].filter((w) => w !== r.name);
    const now = words(e.after);
    return was.length > 0 && was.filter((w) => now.has(w)).length * 2 >= was.length;
  };
  const exampleOf = (view) => {
    const r = view.rows.find((row) => (row.examples || []).some(rewrites(row)));
    const e = r?.examples.find(rewrites(r));
    return e ? `${code(r.name)} · ${e.file}\n\n\`\`\`diff\n${[...e.before.map((l) => `- ${l}`), ...e.after.map((l) => `+ ${l}`)].join('\n')}\n\`\`\`` : '';
  };

  const byWeight = (a, b) => b.rel.groups.reduce((n, g) => n + g.count, 0) - a.rel.groups.reduce((n, g) => n + g.count, 0) || byUse(a, b);
  const foldOk = visible.length > FOLD_OK_OVER;
  const modules = [...MODULES, OTHER_MODULE].map((m) => ({ ...m, views: toViews(visible.filter((r) => r.module.id === m.id).sort(byWeight)) })).filter((m) => m.views.length);
  const count = (views, impact) => views.filter((v) => v.impact === impact).length;

  const sections = [];
  if (modules.length >= 4 && modules.reduce((n, m) => n + m.views.length, 0) >= 12) { // 모듈이 여럿이고 행이 많을 때만 색인을 둔다
    sections.push({
      heading: '한눈에',
      body: ['| 모듈 | 빌드 실패 | 확인 필요 | 그대로 빌드 |', '|---|---:|---:|---:|',
        ...modules.map((m) => `| ${m.title} | ${count(m.views, 'break') || '·'} | ${count(m.views, 'check') || '·'} | ${count(m.views, 'ok') || '·'} |`)].join('\n'),
    });
  }
  for (const m of modules) {
    const open = foldOk ? m.views.filter((v) => v.impact !== 'ok') : m.views;
    const quiet = foldOk ? m.views.filter((v) => v.impact === 'ok') : [];
    const examples = m.views.filter((v) => v.rows.length < 3).map(exampleOf).filter(Boolean).slice(0, 6); // 셋 이상 묶인 행은 한 드라이버의 내부 정리다
    sections.push({
      heading: m.title,
      body: [
        open.length ? table(open) : '',
        quiet.length ? fold(`그대로 빌드되는 변경 ${quiet.length}건`, table(quiet)) : '',
        examples.length ? fold(`고친 예 ${examples.length}건 (메인라인 드라이버)`, examples.join('\n\n')) : '',
      ].filter(Boolean).join('\n\n'),
    });
  }
  // 프로필 경로의 Kconfig 심볼이 사라진 것도 defconfig 에서 조용히 빠지므로 표로 보인다.
  const mineKconfig = driverKconfig.filter((k) => profile.groups.some((g) => g.paths.test(k.file)));
  if (mineKconfig.length) {
    sections.push({
      heading: 'Kconfig',
      body: ['| 영향 | 기존 | 변경 | 주요 설명 |', '|---|---|---|---|', ...mineKconfig.map((k) => `| ${IMPACT.check} | ${mono(`CONFIG&#95;${esc(k.name)}`)}<br>${esc(k.file)} | `
        + `${k.commit?.renamedTo ? `삭제 (같은 커밋이 ${mono(`CONFIG&#95;${esc(k.commit.renamedTo)}`)} 추가)` : '삭제'} | ${k.commit ? commitLink(k.commit, k.commit.subject) : '—'} |`)].join('\n'),
    });
  }
  if (!sections.length) sections.push({ heading: '변경 없음', body: `${from}에서 ${to} 사이에 표에 올릴 API 변경은 없습니다.` });

  // 참고: 다른 서브시스템 안에서만 쓰이던 것과 목록성 자료. 모두 접는다.
  const reference = [];
  if (other.length) {
    const groups = new Map();
    for (const r of [...other].sort(byUse)) {
      const key = r.commit?.sha || `name:${r.name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const labelOf = (r) => (r.loose ? (/^export/.test(r.kind) ? 'export 해제' : REMOVED_LABEL[r.kind] || '삭제') : (r.change === 'removed' ? REMOVED_LABEL : CHANGED_LABEL)[r.kind] || r.change);
    const lines = [...groups.values()].flatMap((g) => (g.length < 3
      ? g.map((r) => `| ${code(displayName(r))} | ${r.module.title} | ${labelOf(r)} | ${r.driverUses ?? '—'} | ${commitLink(r.commit, r.commit?.subject) || '—'} |`)
      : [`| ${g.slice(0, 3).map((r) => code(displayName(r))).join(', ')}${g.length > 3 ? ` 외 ${g.length - 3}개` : ''} | ${g[0].module.title} | ${labelOf(g[0])}${g.some((r) => labelOf(r) !== labelOf(g[0])) ? ' 등' : ''} | ${g[0].driverUses ?? '—'} | ${commitLink(g[0].commit, g[0].commit.subject)} |`]));
    reference.push(fold(`다른 서브시스템 안에서만 쓰이던 변경 ${other.length}건`, [
      ['| 이름 | 모듈 | 변화 | 사용 파일 | 커밋 |', '|---|---|---|---:|---|', ...lines.slice(0, TABLE_CAP)].join('\n'),
      lines.length > TABLE_CAP ? `사용 수가 적은 나머지 ${lines.length - TABLE_CAP}줄은 뺐습니다. 이름은 모두 점검 명령에 있습니다.` : '',
    ].filter(Boolean).join('\n\n')));
  }
  const inTables = new Set(rows.map((r) => r.name));
  const looseChanged = data.exports.changed.filter((c) => !inTables.has(c.name));
  if (looseChanged.length) {
    const groups = new Map();
    for (const c of looseChanged) {
      const key = `${c.from}\0${c.to}\0${c.file}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const lines = [...groups.values()].sort((a, b) => b.length - a.length).slice(0, TABLE_CAP)
      .map((g) => `| ${g.slice(0, 3).map((c) => code(c.name)).join(', ')}${g.length > 3 ? ` 외 ${g.length - 3}개` : ''} | ${cell(g[0].from)} | ${cell(g[0].to)} | ${cell(g[0].file)} |`);
    reference.push(fold(`라이선스·네임스페이스가 바뀐 export ${looseChanged.length}개`,
      ['| 심볼 | 이전 | 이후 | 파일 |', '|---|---|---|---|', ...lines].join('\n')));
  }
  const restKconfig = driverKconfig.filter((k) => !mineKconfig.includes(k));
  if (restKconfig.length) {
    reference.push(fold(`사라진 드라이버 Kconfig 심볼 ${restKconfig.length}개`,
      ['| 심볼 | 위치 | 커밋 |', '|---|---|---|', ...restKconfig.slice(0, 60).map((k) => `| ${code(k.name)} | ${cell(k.file)} | ${commitLink(k.commit, k.commit?.subject) || '—'} |`)].join('\n')));
  }
  // API 가 아닌 변화: 메인테이너가 pull 요청에 쓴 요약을 AI 가 줄인 것. 독자와 가까운 pull 을 먼저 둔다.
  const pullNotes = (pulls) => pulls.filter((p) => notes.subsystems.has(p.id))
    .map((p) => `**${cell(p.title.replace(/^Pull\s+/, ''))}** · [머지](${commitUrl(p.id)})\n${notes.subsystems.get(p.id).map((pt) => `- ${pt}`).join('\n')}`).join('\n\n');
  const nearPulls = pullNotes(input.pulls.filter((p) => p.mine));
  if (nearPulls) reference.push(fold('API 밖의 변화 (메인테이너 요약)', nearPulls));
  const restPulls = pullNotes(input.pulls.filter((p) => !p.mine));
  if (restPulls) reference.push(fold('다른 서브시스템의 메인테이너 요약', restPulls));
  const conversions = [
    ...[...data.broad].sort((a, b) => touchCount(b, profile) - touchCount(a, profile)).slice(0, 15)
      .map((c) => `- ${commitLink(c, c.subject)} — 드라이버 디렉터리 ${c.dirs}곳, 파일 ${c.files}개`),
    ...[...data.campaigns].sort((a, b) => touchCount(b, profile) - touchCount(a, profile)).slice(0, 12)
      .map((c) => `- **${cell(c.pattern)}** — 커밋 ${c.count}개 (${c.prefixes.slice(0, 6).join(', ')}${c.prefixes.length > 6 ? ` 외 ${c.prefixes.length - 6}곳` : ''}) [예시](${commitUrl(c.commits[0])})`),
  ];
  if (conversions.length) reference.push(fold(`여러 드라이버를 한꺼번에 바꾼 커밋 ${data.broad.length}건·반복 패턴 ${data.campaigns.length}건`, conversions.join('\n')));
  const added = areas.filter((a) => a.added.length).map((a) => `- **${a.title}** ${a.added.length}개: ${a.added.slice(0, 30).map(code).join(', ')}${a.added.length > 30 ? ' …' : ''}`);
  if (added.length) reference.push(fold('새로 생긴 함수·매크로·멤버 이름', added.join('\n')));
  const docCommits = data.docs.driverApi.filter((c) => !DOC_NOISE_RE.test(c.subject));
  if (data.docs.deprecated.trim() || docCommits.length) {
    reference.push(fold('폐기 예고·권장 방식 문서', [
      data.docs.deprecated.trim() ? `\`Documentation/process/deprecated.rst\`에 추가된 내용:\n\n\`\`\`text\n${data.docs.deprecated.trim().slice(0, 4000)}\n\`\`\`` : '',
      docCommits.length ? docCommits.slice(0, 20).map((c) => `- ${commitLink(c, c.subject)}`).join('\n') : '',
    ].filter(Boolean).join('\n\n')));
  }

  // 점검 명령은 줄이지 않는다: 표에서 뺀 이름까지 모두 넣어야 "안 나오면 안 걸린다"가 성립한다.
  const usedNames = new Set(used.map((e) => e.name));
  const areaRows = rows.filter((r) => !r.loose);
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
  if (commands.length) reference.push(fold('내 드라이버 점검 명령 (드라이버 소스의 git 저장소에서 실행)', `\`\`\`sh\n${commands.join('\n')}\n\`\`\``));
  if (reference.length) sections.push({ heading: '참고', body: reference.join('\n\n') });

  const views = modules.flatMap((m) => m.views);
  const tally = `빌드 실패 ${count(views, 'break')}건, 확인 필요 ${count(views, 'check')}건, 그대로 빌드 ${count(views, 'ok')}건`;
  const broken = modules.filter((m) => count(m.views, 'break')).map((m) => m.title);
  const cited = [...input.pulls.filter((p) => p.mine), ...input.pulls.filter((p) => notes.subsystems.has(p.id))].filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
  return {
    id: lts ? `${kstDate(toDate)}-linux-${from}-${to}-lts-driver-impact` : `${kstDate(toDate)}-linux-${to}-driver-impact`,
    topic: 'linux-driver-impact',
    title: lts ? `Linux ${from.replace(/^v/, '')} → ${version} LTS 드라이버 영향 노트` : `Linux ${version} 드라이버 영향 노트`,
    headline: views.length ? `${label}: ${tally}${broken.length ? ` (${broken.slice(0, 4).join(', ')}${broken.length > 4 ? ' 등' : ''})` : ''}` : `${label}: 표에 올릴 API 변경 없음`,
    date: kstDate(toDate),
    summary: `커밋 ${commits}개·pull ${merges}개 범위에서 드라이버가 쓰던 API 변경 ${views.length}건을 모듈별 표로 정리했습니다.`,
    tags: ['리눅스', '커널', '드라이버', ...(lts ? ['LTS', from] : []), to],
    sections,
    confidence: {
      level: '자동 생성',
      note: '기존·변경은 두 버전의 헤더를 코드가 비교한 것이고, 영향은 그 시그니처만 보고 가른 것입니다(삭제·인자 변경·콜백 타입 변경은 빌드 실패). 설명은 커밋 메시지를 AI가 줄였습니다. '
        + (active ? '표에는 메인라인의 미디어·Samsung SoC 드라이버가 쓰던 API와 여러 서브시스템이 쓰는 API만 올렸고, 트리 밖 드라이버는 보지 않았습니다.' : '표에는 여러 서브시스템이 쓰는 API만 올렸습니다.'),
    },
    sources: (cited.length ? cited : input.pulls.slice(0, 10)).map((p) => ({ title: p.title, url: commitUrl(p.id), note: 'merge' })),
    draftMetadata: {
      source: 'kernel-git',
      ...(lts ? { kind: 'lts' } : {}),
      range: `${from}..${to}`,
      ...(active ? { profile: profile.id } : {}),
      ai: notes.apiNotes.size > 0 || notes.subsystems.size > 0,
      counts: {
        commits, merges, tableRows: views.length, breaking: count(views, 'break'), check: count(views, 'check'), compatible: count(views, 'ok'),
        explained: views.filter((v) => v.rows.some((r) => notes.apiNotes.has(r.name))).length, folded: other.length,
        removedApis: apis.length, usedRemovedApis: used.length, exportChanges: data.exports.changed.length, driverKconfig: driverKconfig.length,
      },
    },
  };
}
