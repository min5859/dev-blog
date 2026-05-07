# Dev Blog Improvement Plan

## Purpose

Durable improvement track for in-flight quality work on Dev Blog. Future
sessions should read this file after `docs/PLAN.md` and continue from the
first unchecked item.

This plan is scoped to three goals raised on 2026-05-07:

1. Remove redundant "한국어" labels from user-facing strings. The entire
   site is already in Korean, so phrases like "한국어 일일 브리핑" or
   "한국어 문단" add noise without information.
2. Make the UI feel like an engineering magazine, not a casual blog —
   tighter typography, technical markup, more information density.
3. Strengthen practical, action-oriented content: what changed, who is
   affected, what to verify next.

## Status

- Current step: **Step 2 done; Step 3 not started**
- Last touched: 2026-05-07

Update this block whenever a step starts, finishes, or stalls.

## Step 1 — Label cleanup

Goal: drop "한국어" as a redundant qualifier in user-visible strings while
keeping language directives where they instruct AI behavior.

- [x] `scripts/ai-rewrite-linux.mjs:103` — `summary` "...선별한 한국어 일일 브리핑입니다" → "...선별한 일일 커널 개발 브리핑입니다"
- [x] `scripts/draft-linux.mjs:133` — title "${runDate} 리눅스 개발 브리핑 초안" → "${runDate} 커널 개발 브리핑 (초안)"
- [x] `scripts/draft-linux.mjs:158` — nextActions "...한국어 문단으로 재작성합니다." → "...문단 단위로 재작성합니다."
- [x] `prompts/linux-newsletter-ko.md` — replace `"한국어 기술 뉴스레터 편집자"` with `"기술 뉴스레터 편집자"`; replace `"한국어 뉴스레터 JSON만 출력하세요"` with `"뉴스레터 JSON만 출력하세요. 본문은 한국어로 작성합니다."` (one explicit language directive, no scattered labels)
- [x] `README.md:37` — "Generate a Korean newsletter draft" → "Generate a newsletter draft"
- [x] Verify: `rg "한국어" content/ scripts/ prompts/ README.md` returns only language directives (AI prompts), not user-facing labels
- [x] Additional cleanups discovered during verify (committed as part of Step 1):
  - `scripts/build-site.mjs:226` home hero h1 "한국어 브리핑" → "기술 브리핑"
  - `content/topics/linux/posts/2026-05-07-linux-daily-briefing.json:6` summary label
  - `content/topics/linux/posts/2026-05-07-sample.json:6` sample summary label
  - `content/topics/linux/posts/2026-05-07-sample.json:35` sample nextAction label

Exit criteria:

- Build, rewrite, and published outputs contain no "한국어 X" phrasing where the site language is already implicit.
- Verified 2026-05-07: `rg "한국어" public/` → 0 matches; only the AI language directive in `prompts/linux-newsletter-ko.md` remains.

## Step 2 — Draft content quality

Goal: surface practical signal, suppress meta-info noise. Touches mainly
`scripts/draft-linux.mjs`.

- [x] Remove "점수 사유는 ...입니다" from `summarizeCandidate` body output. Keep `score` and `scoreReasons` only in candidate JSON metadata.
- [x] Patch series merge: extract `[PATCH vN]` and `[PATCH vN M/K]`; group candidates by `(stripped_title, author)`; keep only the highest `v`. (Generalized `stripPatchPrefix` to also handle `[PATCH net-next ...]`, `[GIT PULL ...]`, `[RFC ...]`.)
- [x] Subsystem grouping: bucket candidates by `matchedSubsystems` and emit per-subsystem mini-sections (not a flat list). Rendered as `[서브시스템]` block headers inside section body.
- [x] Regression / security bucket: titles matching `/(regression|oops|panic|crash|cve|bug|security|fix)/i` go into a dedicated section, not blended into "패치 동향".
- [x] Stale guard: pure reply mails (`kind === 'mail-reply'` or `title.startsWith('re:')`) older than 24h are dropped from candidates. Kept in source records.
- [x] 3-line impact template per body item: 무엇이 바뀌나 / 누가 영향받나 / 어디를 봐야 하나. Filled from metadata; subsystem-unmatched items show "서브시스템 미분류" without fabrication.
- [x] `scripts/build-site.mjs` — added `.article section p { white-space: pre-line }` so the multi-line bullets render correctly.

Exit criteria:

- `data/generated/linux/draft-latest.json` matches the new structure.
- `assertPost` in `scripts/build-site.mjs` still passes against the new draft.
- Verified 2026-05-07: collect → draft → rewrite → build pipeline runs end-to-end. Bucket counts on real data: releases 5, regressions 1, patches 13, otherSignals 0.

## Step 3 — Prompt redesign

Goal: align the AI adapter and the deterministic template adapter on the
same action-oriented schema.

- [ ] `prompts/linux-newsletter-ko.md` — require for each highlight:
  - 검토 우선순위 (상/중/하)
  - 확인할 changelog/diff 링크 (없으면 명시적으로 "없음")
  - 마지막 줄은 행동 지침 형태 (예: "linux-next에 머지되면 X 모듈을 재컴파일해야 합니다")
- [ ] Extend the output JSON schema with a `priority` field on highlights and (optional) per-section `actions[]`.
- [ ] Sync `templateRewrite` in `scripts/ai-rewrite-linux.mjs` so it populates the same fields from metadata when `AI_ADAPTER=template` is used.

Exit criteria:

- `template` and `claude` adapters emit identical schemas.
- `validatePost` (in `scripts/ai-rewrite-linux.mjs` and `scripts/publish-linux.mjs`) enforces the required new fields.

## Step 4 — UI redesign (`scripts/build-site.mjs`)

Goal: engineering-magazine tone, technical density, scanability. All work
lives in `scripts/build-site.mjs` (CSS is inlined there today; keep it
inlined for now to preserve the zero-dependency property).

Typography:

- [ ] Body font stack: `-apple-system, "SF Pro Text", "Inter", "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`
- [ ] Headings: `letter-spacing: -0.02em`, weight 700, slightly tighter line-height
- [ ] Inline code stack: `ui-monospace, "JetBrains Mono", "SF Mono", monospace`
- [ ] Body `line-height` 1.7 → 1.65

Color & surfaces:

- [ ] Replace hero gradient with a left accent rail + meta strip
- [ ] Light accent: `#1f6feb` (GitHub-tone blue)
- [ ] Dark mode bg: `#0b0f17`, surface: `#111827`, border: `#1f2a3a`
- [ ] Card border radius: 18px → 10px

Layout:

- [ ] Article body width: 820px → 720px
- [ ] Article page: sticky left meta column (date / topic / reading time / source-kind summary)
- [ ] Home hero replaced by a "Release status" table: mainline (latest RC/release), latest stable, longterm rows, EOL count. Data comes from kernel.org records in `data/normalized/linux/source-records-latest.json`.
- [ ] Post card simplified: title + 1-line summary + tag chips (drop the eyebrow "주제 · X분" duplication)

Technical markup (post-processing in `build-site.mjs`):

- [ ] Auto-wrap in `<code>`: kernel versions (`/v?\d+\.\d+(?:[.-][\w.-]+)?/`), subsystem slugs (`/\b(mm|net|fs|sched|drivers|arch|crypto|block)\//`), commit SHAs (`/\b[0-9a-f]{7,40}\b/`)
- [ ] Source link `kind` chip rendered next to each source: release / patch / pull-request / discussion / mail-reply

Footer & meta:

- [ ] Footer line: `last build: YYYY-MM-DD HH:mm KST · source records: N · candidates: M`. Numbers come from `draftMetadata` and a new `lastBuildAt` field.

Exit criteria:

- `npm run dev` shows the redesigned site at `http://localhost:4321`.
- Visual review confirms denser, engineering-tone layout on at least: home, archive, a topic page, an article page, the tags index.

## Step 5 — Search index & metadata

- [ ] `public/search-index.json` entries gain `topic`, `tags`, `subsystems`, `priority` (when present).
- [ ] `build-site.mjs` writes `lastBuildAt` (KST) into a small meta object consumed by the footer template.

Exit criteria:

- Search index keys: `id, title, date, topic, summary, tags, subsystems, priority, url`.

## Step 6 — Validation hardening

- [ ] `scripts/publish-linux.mjs` — extend `validatePost` to enforce that the rewritten post has not mutated `id`, `topic`, or `date` away from the source draft.
- [ ] Add minimal `node --test` cases (no new dependencies):
  - `scripts/draft-linux.test.mjs` — `scoreRecord` on representative records
  - patch series merge picks the highest `v`
  - subsystem classifier hits the expected label
- [ ] `package.json` — add `"test": "node --test scripts/*.test.mjs"`

Exit criteria:

- `npm test` passes locally.
- A rewritten post that mutates `id`/`topic`/`date` fails `publish:linux` with a clear error.

## Out of scope (deferred to `docs/PLAN.md`)

- OpenClaw adapter (Phase 3 of PLAN.md)
- Multi-topic expansion (Phase 6 of PLAN.md)
- Hosting / deployment beyond local-only
- Replacing the regex-based Atom parser

## Continuation Protocol (read this on every fresh session)

1. Read `AGENTS.md` and `docs/PLAN.md` for global context.
2. Read this file end-to-end. Locate the first unchecked item.
3. Run `git status --short` to confirm a clean baseline.
4. Make the smallest verifiable change for that item.
5. Validate with the smallest meaningful command:
   - Step 1: `rg "한국어"` + `npm run rewrite:linux && npm run build`
   - Step 2: `npm run draft:linux` and inspect `data/generated/linux/draft-latest.json`
   - Step 3: `AI_ADAPTER=template npm run rewrite:linux` and inspect `rewritten-latest.json`
   - Step 4: `npm run dev` and visual check
   - Step 5: `cat public/search-index.json | head`
   - Step 6: `npm test`
6. Commit with a message scoped to one Step (example: `Step 1: drop redundant 한국어 labels`).
7. Update the matching checkbox in this file in the same commit.
8. Update the **Status** block: current step + last touched date.

Do not skip steps unless explicitly approved. Do not bundle multiple Steps
into one PR — each Step has its own exit criteria so that incremental
review is cheap.
