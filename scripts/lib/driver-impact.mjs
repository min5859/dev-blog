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

/** `git grep <tag>` 줄들 → Map(name → { kinds: Set, file }). kind 는 매크로 이름과 네임스페이스 등 추가 인자. */
export function parseExports(lines) {
  const map = new Map();
  for (const line of lines) {
    const [file, text] = splitGrepLine(line);
    if (/^\s*#\s*define\b/.test(text)) continue;
    const m = EXPORT_RE.exec(text);
    if (!m) continue;
    const kind = m[3] ? `${m[1]}(${m[3]})` : m[1];
    const entry = map.get(m[2]) || { kinds: new Set(), file };
    entry.kinds.add(kind);
    map.set(m[2], entry);
  }
  return map;
}

export function exportName(text) {
  return /^\s*#\s*define\b/.test(text) ? null : EXPORT_RE.exec(text)?.[2] || null;
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
 * pick(text) → name|null.
 */
export function removalCommits(lines, pick) {
  const removedBy = new Map();
  const addedIn = new Map();
  for (const { sha, subject, file, sign, text } of lines) {
    const name = pick(text);
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
    }))
    .filter((g) => g.count >= minCount && g.prefixes.length >= minPrefixes)
    .sort((a, b) => b.count - a.count);
}

/** 드라이버 디렉터리를 넓게 건드린 커밋(트리 전체 전환·API 일괄 변경 후보). */
export function broadCommits(commits, { minDirs = 10 } = {}) {
  return commits
    .map((c) => {
      const driverFiles = c.files.filter((f) => DRIVER_PATH_RE.test(f));
      const dirs = new Set(driverFiles.map((f) => f.split('/').slice(0, -1).slice(0, 4).join('/')));
      return { sha: c.sha, subject: c.subject, files: driverFiles.length, dirs: dirs.size };
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
/** 드라이버가 많이 쓰는 영역. headers: 비교할 헤더, sources: export 가 있는 소스, pulls: pull 태그. */
export const FOCUS_AREAS = [
  { id: 'mm', title: '메모리·DMA',
    headers: linuxH('mm|mm_types|gfp|gfp_types|slab|vmalloc|highmem|highmem-internal|mmzone|page-flags|page_ref|memremap|mempool|mmap_lock|huge_mm|io-mapping|uaccess|dma-mapping|dma-direction|dmapool|scatterlist|dma-buf|dma-fence|dma-resv'),
    sources: /^(?:mm\/|kernel\/dma\/|lib\/scatterlist\.c$|drivers\/dma-buf\/)/,
    pulls: /^(?:mm-(?:stable|core)|slab-|dma-mapping-|memblock-)/ },
  { id: 'v4l2', title: 'V4L2·videobuf2·미디어 컨트롤러',
    headers: /^include\/media\//,
    sources: /^drivers\/media\/(?:v4l2-core|common\/videobuf2|mc)\//,
    pulls: /^media\// },
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
];

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

/** 구조체 본문 → Map(member → Set(선언)). 안쪽 익명 struct·union 은 펼친다. */
function parseMembers(block) {
  const members = new Map();
  const add = (name, decl) => members.set(name, (members.get(name) || new Set()).add(decl));
  const flat = block.replace(/\b(?:struct|union|enum)(?:\s+\w+)?\s*\{/g, ';').replace(/\}[^;{}]*;/g, ';');
  for (const raw of splitTop(flat, ';')) {
    const stmt = stripAttrs(raw);
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
 * `__signed_wrap`, `__iomem`)이다. 양쪽에 서로 다른 `__` 이름이 있으면(`__u32` → `__le32`) 변화로 둔다.
 */
export function compatibleChange(was, now) {
  if (was === '(...)' || now === '(...)') return true;
  const words = (s) => s.match(/\b__[a-z0-9_]+\b/g) || [];
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

const COMMIT_URL = 'https://git.kernel.org/torvalds/c/';
export const shortSha = (sha) => sha.slice(0, 12);
const commitUrl = (sha) => `${COMMIT_URL}${shortSha(sha)}`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const code = (s) => `\`${String(s).replace(/`/g, '')}\``;
const clip = (s, max = 120) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const REMOVED_LABEL = { function: '함수 삭제', macro: '매크로 삭제', constant: '상수 삭제', variable: '변수 삭제', struct: '구조체 삭제', member: '멤버 삭제', export: 'export 해제' };
const CHANGED_LABEL = { function: '시그니처 변경', macro: '매크로 인자 수 변경', variable: '타입 변경', member: '멤버 타입 변경', export: 'export 변경' };

export function isDriverPull(p) {
  return p.driverFiles >= 5 || (p.files > 0 && p.driverFiles / p.files >= 0.3);
}

/** 지워진 export 와 헤더 선언을 이름 하나로 합치고 v7.3 드라이버 사용 횟수 순으로 둔다. */
export function removedApis(data) {
  const byName = new Map();
  for (const e of data.exports.removed) {
    if (e.header === 'inline') continue;
    byName.set(e.name, { ...e, kind: e.header === 'declared' ? `export 해제(선언은 남음) ${e.kind}` : `export ${e.kind}` });
  }
  for (const h of data.headers) if (!byName.has(h.name)) byName.set(h.name, h);
  return [...byName.values()].sort((a, b) => b.driverUses - a.driverUses || a.name.localeCompare(b.name));
}

/**
 * 중점 영역마다 드라이버가 쓰던 API 의 변화(헤더 비교 + 영역 소스의 export 변화), 새 이름, 관련 pull.
 * rows 는 사용 파일 수 순서다.
 */
export function focusAreas(data) {
  return FOCUS_AREAS.map((area) => {
    const found = (data.focus || []).find((f) => f.id === area.id) || { files: 0, items: [] };
    const exportRows = [
      ...data.exports.removed.filter((e) => area.sources.test(e.file) && e.header !== 'inline' && e.driverUses > 0)
        .map((e) => ({ change: 'removed', kind: 'export', name: e.name, before: e.kind, driverUses: e.driverUses, commit: e.commit })),
      ...data.exports.changed.filter((c) => area.sources.test(c.file))
        .map((c) => ({ change: 'changed', kind: 'export', name: c.name, before: c.from, after: c.to, driverUses: null, commit: null })),
    ];
    const seen = new Set();
    const renamed = new Map([...data.exports.removed, ...data.headers].filter((e) => e.commit?.renamedTo).map((e) => [e.name, e.commit.renamedTo]));
    const rows = [...found.items.filter((i) => i.change !== 'added'), ...exportRows]
      .map((r) => (r.change === 'removed' && renamed.get(r.name) ? { ...r, renamedTo: renamed.get(r.name) } : r))
      .filter((r) => !seen.has(r.name) && seen.add(r.name))
      .sort((a, b) => (b.driverUses ?? 0) - (a.driverUses ?? 0) || a.name.localeCompare(b.name));
    const isFix = (p) => /\bfix(?:es)?\b|urgent/i.test(`${p.tag} ${p.title}`);
    return {
      id: area.id,
      title: area.title,
      files: found.files,
      rows,
      added: found.items.filter((i) => i.change === 'added').map((i) => i.name),
      same: found.same || {},
      pulls: data.pulls.filter((p) => area.pulls.test(p.tag) && !isFix(p)),
    };
  });
}

export function buildAiInput(data, { maxPulls = 45, summaryChars = 2500 } = {}) {
  const areas = focusAreas(data);
  const focusPulls = new Set(areas.flatMap((a) => a.pulls.map((p) => p.sha)));
  const pulls = data.pulls.filter((p) => isDriverPull(p) && !/\bfix(?:es)?\b/i.test(p.title)).sort((a, b) => b.driverFiles - a.driverFiles).slice(0, maxPulls)
    .concat(data.pulls.filter((p) => focusPulls.has(p.sha)))
    .filter((p, i, all) => all.findIndex((q) => q.sha === p.sha) === i)
    .map((p) => ({ id: shortSha(p.sha), title: p.title, summary: p.summary.slice(0, summaryChars) }));
  const focus = areas.map((a) => ({
    id: a.id,
    title: a.title,
    changes: a.rows.slice(0, 25).map((r) => ({
      change: r.change, kind: r.kind, name: r.name, ...(r.before ? { before: r.before } : {}), ...(r.after ? { after: r.after } : {}),
      ...(r.renamedTo ? { renamedTo: r.renamedTo } : {}), driverUses: r.driverUses, commit: r.commit ? shortSha(r.commit.sha) : null,
    })),
    pulls: a.pulls.map((p) => shortSha(p.sha)), // 새 이름 목록은 주지 않는다: 이름만 보고 용도를 짐작하게 된다
    ...(Object.keys(a.same).length ? { unchangedMembers: a.same } : {}),
  }));
  const apiRemovals = removedApis(data).filter((e) => e.driverUses > 0).slice(0, 40).map((e) => ({
    name: e.name, kind: e.kind, driverUses: e.driverUses,
    commit: e.commit ? shortSha(e.commit.sha) : null, ...(e.commit?.renamedTo ? { renamedTo: e.commit.renamedTo } : {}),
  }));
  const conversions = [
    ...data.broad.slice(0, 20).map((c) => ({ id: shortSha(c.sha), subject: c.subject, driverDirs: c.dirs })),
    ...data.campaigns.slice(0, 12).map((c) => ({ id: shortSha(c.commits[0]), pattern: c.pattern, commits: c.count, subsystems: c.prefixes.slice(0, 8) })),
  ];
  const messages = Object.fromEntries(Object.entries(data.messages).map(([sha, body]) => [shortSha(sha), body]));
  return { range: { from: data.range.from, to: data.range.to }, focus, pulls, apiRemovals, conversions, messages };
}

// 영문 사이에 한글이 끼어든 토큰("fl사/eject")과 한자·가나는 모델 출력이 깨진 흔적이다.
const GARBLED_RE = /[A-Za-z][가-힣]{1,2}[A-Za-z/]|[\u3040-\u30ff\u4e00-\u9fff]/;
// 입력 JSON 필드 이름이 글에 새면 안 된다.
const INPUT_FIELD_RE = /\b(?:unchangedMembers|apiRemovals|driverUses|renamedTo|focusNotes|conversionNotes|apiNotes)\b/;

/**
 * AI 출력에서 입력에 있는 id·이름을 가리키는 항목만 남긴다. 길이를 넘기거나 URL 을 넣었거나,
 * 백틱으로 감싼 이름이 입력에 없거나, 글자가 깨진 항목은 버린다.
 * 반환: { notes, dropped } — dropped 는 버린 항목 수.
 */
export function cleanNotes(raw, input) {
  const pullIds = new Set(input.pulls.map((p) => p.id));
  const convIds = new Set(input.conversions.map((c) => c.id));
  const apiNames = new Set([...input.apiRemovals.map((a) => a.name), ...(input.focus || []).flatMap((f) => f.changes.map((c) => c.name))]);
  const focusIds = new Set((input.focus || []).map((f) => f.id));
  const haystack = JSON.stringify(input);
  const ticked = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\(\)$/, ''));
  const grounded = (s) => ticked(s).every((t) => haystack.includes(t.split('*')[0]));
  // 헤더 비교로 그대로인 멤버를, 같은 구조체의 바뀐 멤버와 함께 바뀌었다고 쓴 문장(요약·커밋 메시지를 따른 오류).
  const sameMembers = (input.focus || []).flatMap((f) => Object.entries(f.unchangedMembers || {}).map(([struct, same]) => ({
    same: new Set(same), changed: f.changes.filter((c) => c.name.startsWith(`${struct}.`)).map((c) => c.name.slice(struct.length + 1)),
  })));
  // `get_fmt` 처럼 구별되는 이름(밑줄 포함, 6자 이상)은 언급만 해도, `name` 같은 흔한 이름은 바뀐 멤버와 함께 쓸 때만 버린다.
  const changedNames = new Set((input.focus || []).flatMap((f) => f.changes.flatMap((c) => c.name.split('.'))));
  const distinct = new Set(sameMembers.flatMap(({ same }) => [...same]).filter((m) => m.includes('_') && m.length >= 6 && !changedNames.has(m)));
  const contradicts = (s) => {
    const names = ticked(s).flatMap((t) => t.split(/[.\s(),*]+/));
    return names.some((n) => distinct.has(n))
      || sameMembers.some(({ same, changed }) => names.some((n) => same.has(n)) && names.some((n) => changed.includes(n)));
  };
  const text = (s, max) => (typeof s === 'string' && s.trim() && s.length <= max && !/https?:\/\//.test(s)
    && !GARBLED_RE.test(s) && !INPUT_FIELD_RE.test(s) && grounded(s) && !contradicts(s) ? s.trim() : null);
  let dropped = 0;
  const keep = (list, fn) => (Array.isArray(list) ? list : []).flatMap((item) => {
    const value = item && typeof item === 'object' ? fn(item) : null;
    if (!value) dropped += 1;
    return value ? [value] : [];
  });
  const notes = {
    overview: keep(raw.overview, (o) => {
      const refs = (Array.isArray(o.refs) ? o.refs : []).filter((r) => pullIds.has(r) || convIds.has(r) || apiNames.has(r));
      const t = text(o.text, 400);
      return t && refs.length ? { text: t, refs } : null;
    }).slice(0, 8),
    apiNotes: new Map(keep(raw.apiNotes, (n) => (apiNames.has(n.name) && text(n.replacement, 300) ? [n.name, text(n.replacement, 300)] : null))),
    conversionNotes: new Map(keep(raw.conversionNotes, (n) => (convIds.has(n.id) && text(n.action, 300) ? [n.id, text(n.action, 300)] : null))),
    subsystems: new Map(keep(raw.subsystems, (s) => {
      const points = (Array.isArray(s.points) ? s.points : []).map((p) => text(p, 400)).filter(Boolean).slice(0, 4);
      return pullIds.has(s.id) && points.length ? [s.id, points] : null;
    })),
    focus: new Map(keep(raw.focusNotes, (f) => {
      const points = (Array.isArray(f.points) ? f.points : []).map((p) => text(p, 400)).filter(Boolean).slice(0, 4);
      return focusIds.has(f.id) && points.length ? [f.id, points] : null;
    })),
  };
  return { notes, dropped };
}

const EMPTY_NOTES = { overview: [], apiNotes: new Map(), conversionNotes: new Map(), subsystems: new Map(), focus: new Map() };

function kstDate(iso) {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 수집 사실 + (있으면) AI 요약 → Dev Blog 글 JSON. 표·명령·링크는 모두 코드가 만든다.
 * lts: LTS → 다음 LTS 노트. 같은 끝 버전의 일반 노트와 id·제목이 겹치지 않고 draftMetadata.kind 로 구분한다.
 */
export function buildPost(data, input, notes = EMPTY_NOTES, { lts = false } = {}) {
  const { from, to, toDate, commits, merges } = data.range;
  const version = to.replace(/^v/, '');
  const label = lts ? `LTS ${from} → LTS ${to}` : `${from} → ${to}`;
  const apis = removedApis(data);
  const used = apis.filter((e) => e.driverUses > 0);
  const driverKconfig = data.kconfig.removed.filter((k) => /^(?:drivers|sound)\//.test(k.file))
    .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const pullById = new Map(input.pulls.map((p) => [p.id, p]));
  const ref = (r) => {
    if (pullById.has(r)) return `[${pullById.get(r).title.replace(/^Pull\s+/, '')}](${commitUrl(r)})`;
    if (input.conversions.some((c) => c.id === r)) return `[커밋 ${r.slice(0, 7)}](${commitUrl(r)})`;
    return code(r);
  };
  const removalCommit = (c) => (c ? `[${cell(c.subject)}](${commitUrl(c.sha)})` : '—');
  const sections = [];

  if (notes.overview.length) {
    sections.push({ heading: '먼저 볼 것', body: notes.overview.map((o) => `- ${o.text} — ${o.refs.map(ref).join(', ')}`).join('\n') });
  }

  const areas = focusAreas(data);
  const focusBlocks = areas.map((a) => {
    const rows = a.rows.slice(0, 20).map((r) => {
      const label = (r.change === 'removed' ? REMOVED_LABEL : CHANGED_LABEL)[r.kind] || r.change;
      const what = r.change === 'changed' ? `${code(clip(r.before))} → ${code(clip(r.after))}`
        : `${r.before ? code(clip(r.before)) : '—'}${r.renamedTo ? ` → ${code(r.renamedTo)} (같은 커밋에서 추가)` : ''}`;
      return `| ${label} | ${code(r.name)} | ${what} | ${r.driverUses ?? '—'} | ${removalCommit(r.commit)} |`;
    });
    const points = notes.focus.get(a.id);
    return [
      `### ${a.title}`,
      points ? points.map((p) => `- ${p}`).join('\n') : '',
      rows.length
        ? ['| 변화 | 이름 | 이전 → 이후 | 사용 | 커밋 |', '|---|---|---|---:|---|', ...rows].join('\n')
        : a.files ? `헤더 ${a.files}개가 바뀌었지만 ${from} 드라이버가 쓰던 API의 삭제·시그니처 변경은 없습니다.` : '이번 범위에서 이 영역의 헤더는 바뀌지 않았습니다.',
      a.rows.length > rows.length ? `나머지 ${a.rows.length - rows.length}개는 점검 명령에 넣었습니다.` : '',
      a.added.length ? `새로 생긴 함수·매크로·멤버 ${a.added.length}개: ${a.added.slice(0, 30).map(code).join(', ')}${a.added.length > 30 ? ' …' : ''}` : '',
      a.pulls.length ? `관련 pull: ${a.pulls.map((p) => `[${cell(p.title.replace(/^Pull\s+/, ''))}](${commitUrl(p.sha)})`).join(' · ')}` : '',
    ].filter(Boolean).join('\n\n');
  });
  sections.push({
    heading: '중점 API 영역',
    body: [
      `드라이버가 많이 쓰는 영역의 헤더를 ${from}과 ${to}에서 각각 파싱해 비교했습니다. 시그니처·구조체 멤버가 바뀐 것은 컴파일 오류나 콜백 대입 오류로 드러납니다. `
        + '`사용`은 이전 버전 drivers/·sound/에서 그 이름을 쓴 파일 수이고, 구조체 멤버는 \`struct 구조체\`가 나오고 \`->멤버\`·\`.멤버\`로 접근하는 파일 수입니다(타입은 확인하지 않아 상한값입니다). '
        + '표는 헤더를 직접 비교한 결과라, 요약 문장이나 메인테이너 pull 요약과 다르면 표가 맞습니다.',
      ...focusBlocks,
    ].join('\n\n'),
  });

  const apiRows = used.slice(0, 50).map((e) => {
    const instead = notes.apiNotes.get(e.name) || (e.commit?.renamedTo ? `${code(e.commit.renamedTo)} (같은 커밋에서 추가)` : '—');
    return `| ${code(e.name)} | ${cell(e.kind)} | ${e.driverUses} | ${cell(instead)} | ${removalCommit(e.commit)} |`;
  });
  const changed = data.exports.changed.slice(0, 40).map((c) => `| ${code(c.name)} | ${cell(c.from)} | ${cell(c.to)} | ${cell(c.file)} |`);
  sections.push({
    heading: '빌드가 깨질 수 있는 변경',
    body: [
      `${from}에 있던 export 심볼·헤더 함수·매크로·구조체 가운데 ${to}에서 사라진 것이 ${apis.length}개이고, 그중 ${from}의 drivers/·sound/에서 쓰이던 것이 ${used.length}개입니다. `
        + '`사용`은 그 이름이 나온 횟수로, 트리 밖 드라이버가 걸릴 가능성을 가늠하는 값입니다.',
      apiRows.length ? ['| 이름 | 종류 | 사용 | 대신 쓸 것 | 지운 커밋 |', '|---|---|---:|---|---|', ...apiRows].join('\n') : '드라이버에서 쓰이던 API 가운데 사라진 것은 없습니다.',
      used.length > apiRows.length ? `사용 횟수가 적은 ${used.length - apiRows.length}개는 아래 점검 명령에만 넣었습니다.` : '',
      changed.length ? [
        '**라이선스·네임스페이스가 바뀐 export** — `_GPL`이 붙으면 GPL이 아닌 모듈은 더 쓸 수 없고, 네임스페이스가 붙으면 `MODULE_IMPORT_NS()`가 필요합니다.',
        ['| 심볼 | 이전 | 이후 | 파일 |', '|---|---|---|---|', ...changed].join('\n'),
      ].join('\n\n') : '',
    ].filter(Boolean).join('\n\n'),
  });

  const names = used.slice(0, 150).map((e) => e.name);
  const focusNames = [...new Set(areas.flatMap((a) => a.rows.filter((r) => r.kind !== 'member' && r.kind !== 'export').map((r) => r.name)))]
    .filter((n) => !names.includes(n)).slice(0, 150);
  const changedNames = data.exports.changed.slice(0, 80).map((c) => c.name);
  const kconfigNames = driverKconfig.slice(0, 120).map((k) => k.name);
  sections.push({
    heading: '내 드라이버 점검 명령',
    body: [
      '드라이버 소스 디렉터리에서 실행하면 위 변경에 걸리는 곳을 찾습니다. 아무것도 나오지 않으면 이 목록에는 걸리지 않습니다.',
      '```sh',
      names.length ? `# 사라진 API\ngit grep -nwE '${names.join('|')}'` : '',
      focusNames.length ? `# 중점 영역에서 시그니처가 바뀌거나 사라진 API\ngit grep -nwE '${focusNames.join('|')}'` : '',
      changedNames.length ? `# 라이선스·네임스페이스가 바뀐 export\ngit grep -nwE '${changedNames.join('|')}'` : '',
      kconfigNames.length ? `# 사라진 드라이버 Kconfig 심볼\ngrep -rnwE '(CONFIG_)?(${kconfigNames.join('|')})' --include='Kconfig*' --include='Makefile' --include='*defconfig' .` : '',
      '```',
    ].filter(Boolean).join('\n'),
  });

  const campaigns = data.campaigns.slice(0, 12).map((c) => {
    const id = shortSha(c.commits[0]);
    const more = c.prefixes.length > 6 ? ` 외 ${c.prefixes.length - 6}곳` : '';
    const action = notes.conversionNotes.get(id);
    return `- **${cell(c.pattern)}** — 커밋 ${c.count}개 (${c.prefixes.slice(0, 6).join(', ')}${more}). ${action ? `${action} ` : ''}[예시](${commitUrl(c.commits[0])})`;
  });
  if (campaigns.length) {
    sections.push({ heading: '반복 전환 패턴', body: ['여러 서브시스템이 같은 변경을 되풀이한 것입니다. 진행 중인 API 전환이라 트리 밖 드라이버도 따라가야 할 가능성이 큽니다.', campaigns.join('\n')].join('\n\n') });
  }

  const broad = data.broad.slice(0, 15).map((c) => {
    const action = notes.conversionNotes.get(shortSha(c.sha));
    return `- [${cell(c.subject)}](${commitUrl(c.sha)}) — 드라이버 디렉터리 ${c.dirs}곳, 파일 ${c.files}개.${action ? ` ${action}` : ''}`;
  });
  if (broad.length) {
    sections.push({ heading: '넓은 범위 변경', body: ['한 커밋이 여러 드라이버 디렉터리를 함께 바꾼 것입니다. 콜백 시그니처나 헬퍼가 바뀐 경우가 많습니다.', broad.join('\n')].join('\n\n') });
  }

  const kconfigRows = driverKconfig.slice(0, 60).map((k) => `| ${code(k.name)} | ${cell(k.file)} | ${k.commit?.renamedTo ? code(k.commit.renamedTo) : '—'} | ${removalCommit(k.commit)} |`);
  sections.push({
    heading: '사라진 Kconfig 심볼',
    body: [
      `전체 ${data.kconfig.removed.length}개가 사라졌고 새로 ${data.kconfig.added}개가 생겼습니다. drivers/·sound/ 아래의 ${driverKconfig.length}개는 defconfig나 \`depends on\`에 남아 있으면 경고 없이 빠지니 확인이 필요합니다.`,
      kconfigRows.length ? ['| 심볼 | 위치 | 이름 변경 후보 | 지운 커밋 |', '|---|---|---|---|', ...kconfigRows].join('\n') : '',
      driverKconfig.length > kconfigRows.length ? `나머지 ${driverKconfig.length - kconfigRows.length}개는 점검 명령에 넣었습니다.` : '',
    ].filter(Boolean).join('\n\n'),
  });

  const focusCount = new Set(areas.flatMap((a) => a.rows.map((r) => r.name))).size;
  const docCommits = data.docs.driverApi.slice(0, 20).map((c) => `- [${cell(c.subject)}](${commitUrl(c.sha)})`);
  sections.push({
    heading: '폐기 예고·권장 방식 문서',
    body: [
      data.docs.deprecated.trim()
        ? `\`Documentation/process/deprecated.rst\`에 추가된 내용입니다.\n\n\`\`\`text\n${data.docs.deprecated.trim().slice(0, 4000)}\n\`\`\``
        : `이번 범위에서 \`Documentation/process/deprecated.rst\`는 바뀌지 않았습니다.`,
      docCommits.length ? `\`Documentation/driver-api/\`를 바꾼 커밋 ${data.docs.driverApi.length}개:\n\n${docCommits.join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
  });

  const subsystemBlocks = input.pulls.map((p) => {
    const points = notes.subsystems.get(p.id);
    if (!points && notes.subsystems.size) return '';
    return `**${cell(p.title)}** · [머지](${commitUrl(p.id)})${points ? `\n${points.map((pt) => `- ${pt}`).join('\n')}` : ''}`;
  }).filter(Boolean);
  sections.push({
    heading: '서브시스템별 요약',
    body: [
      notes.subsystems.size ? '각 메인테이너가 pull 요청에 쓴 요약에서 드라이버에 영향 있는 점만 추렸습니다.' : '드라이버 파일을 많이 바꾼 pull 순서입니다.',
      subsystemBlocks.join('\n\n'),
    ].join('\n\n'),
  });

  return {
    id: lts ? `${kstDate(toDate)}-linux-${from}-${to}-lts-driver-impact` : `${kstDate(toDate)}-linux-${to}-driver-impact`,
    topic: 'linux-driver-impact',
    title: lts ? `Linux ${from.replace(/^v/, '')} → ${version} LTS 드라이버 영향 노트` : `Linux ${version} 드라이버 영향 노트`,
    headline: notes.overview[0]?.text || `${label}: 드라이버 개발자가 확인할 변경`,
    date: kstDate(toDate),
    summary: `${label}: 커밋 ${commits}개, pull ${merges}개. 드라이버에서 쓰이던 API ${used.length}개와 드라이버 Kconfig 심볼 ${driverKconfig.length}개가 사라졌고, `
      + `메모리·V4L2·타이머 등 중점 영역에서 드라이버가 쓰던 API ${focusCount}개가 바뀌거나 사라졌습니다. 반복 전환 패턴은 ${data.campaigns.length}건입니다.`,
    tags: ['리눅스', '커널', '드라이버', ...(lts ? ['LTS', from] : []), to],
    sections,
    confidence: {
      level: '자동 생성',
      note: `${from}..${to} git 기록에서 코드가 뽑은 사실과, 그 커밋·pull 문구만 본 AI 요약입니다(웹 검색 없음). `
        + `사용 수는 ${from} drivers/·sound/에서 그 이름을 쓴 파일 수이고, 구조체 멤버는 타입을 확인하지 않은 상한값입니다.`,
    },
    sources: input.pulls.map((p) => ({ title: p.title, url: commitUrl(p.id), note: 'merge' })),
    draftMetadata: {
      source: 'kernel-git',
      ...(lts ? { kind: 'lts' } : {}),
      range: `${from}..${to}`,
      ai: notes.overview.length > 0,
      counts: { commits, merges, focusChanges: focusCount, removedApis: apis.length, usedRemovedApis: used.length, exportChanges: data.exports.changed.length, driverKconfig: driverKconfig.length, campaigns: data.campaigns.length, broad: data.broad.length },
    },
  };
}
