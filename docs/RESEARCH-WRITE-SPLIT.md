# Research / Write Agent Split — Design

## Purpose

Durable design doc for splitting the single AI rewrite stage into two
distinct agents:

1. a **research agent** that does judgment-driven investigation with tools,
2. a **write agent** that turns the research dossier into the newsletter post.

Goal: raise the *qualitative* depth of post content — more verified signal,
fewer shallow rephrasings, lower hallucination risk.

Read `docs/ARCHITECTURE.md` and `docs/IMPROVEMENT-PLAN.md` first. This doc
follows the same Step + exit-criteria convention so work is reviewable in
small increments.

## Status

- Current step: **PoC complete (Steps 1–4 done, linux topic)**
- Last touched: 2026-06-06

### PoC result (2026-06-06)

`DAILY_REWRITE_ADAPTER=template node scripts/run-daily-linux.mjs` ran
`collect → draft → research → rewrite → build` end-to-end, all steps ok.

- research produced a 6-entry dossier (6 evidence claims) from the day's
  candidates.
- the write step consumed `research-latest.json` and emitted a post whose
  10 URLs (highlights `verifyLink` + `sources`) were **10/10 grounded** in
  dossier evidence — zero ungrounded URLs (the `findUngroundedUrls`
  invariant held against the dossier).
- `draftMetadata.promptTemplate` switched to
  `prompts/linux-newsletter-from-dossier-ko.md`, confirming the dossier
  write path is live.

Before vs after, structurally: the old flow fed the writer the draft
(metadata + 700-char excerpts) and grounded against that; the new flow feeds
a research dossier (judgment-gathered, sourced evidence) and grounds against
that. Investigation and writing are now separate stages with an auditable
contract between them.

Next: run the `claude` research adapter (`research:linux:claude`) on a real
day to measure the *content* lift (tool-fetched evidence beyond the
deterministic fallback), then decide on multi-topic rollout.

## 1. Where the quality ceiling actually is

The pipeline today is `collect → draft → rewrite(AI) → publish`.

Contrary to a first read, the depth ceiling is **not** the 700-char Atom
excerpt from `collect-linux.mjs`. The `draft` stage already performs a
**deterministic research layer** on the selected candidates
(`scripts/draft-linux.mjs`):

- `fetchLoreBody` → fetches the lore `/raw` mbox and extracts up to 2400
  chars of commit message (`extractCommitMessage`).
- `fetchMaintainerThreadComments` → fetches the thread `t.atom` and pulls
  excerpts from known maintainers (`KNOWN_MAINTAINERS`).
- `fetchChangelog` → fetches the kernel.org changelog and summarizes
  backported commit subjects (`summarizeChangelog`).

So `draft` = candidate selection (scoring, patch-series merge, subsystem
bucketing) **plus** a fixed enrichment pass. `rewrite` = a single,
**tool-less** AI transform (`ai-rewrite-adapter.mjs`: `claude -p
--output-format text`, `codex exec`) that polishes what `draft` handed it.

The real limits:

1. **Research is regex-fixed, not reasoned.** The pipeline fetches the same
   three things every time. It never decides "this patch cites a `Fixes:`
   hash — pull that commit too" or "this looks like a known CVE — confirm
   it." Fetching without judgment.
2. **The write step has no tools.** It cannot follow a link, confirm a
   claim, or disambiguate. It can only rephrase the draft, which is why the
   prompt (`prompts/linux-newsletter-ko.md`) has to fight hallucination so
   hard.
3. **No secondary analysis sources.** Only lore + kernel.org. No LWN,
   Phoronix, Git commit ranges, or CVE databases — the sources that carry
   *interpretation*, not just raw events.

## 2. Proposed shape

Insert a research stage between candidate selection and writing:

```
collect → draft(select)  →  research(AI + tools)  →  write(AI)  → publish
                            │  produces dossier   │  consumes    │
                            └─ data/generated/.../ └─ dossier     │
                               research-latest.json   only        │
```

- **draft** loses its `enrichWithBodies` responsibility (or keeps it as a
  cheap fallback) and focuses on deterministic candidate *selection* — the
  part that should stay reproducible and testable.
- **research agent** takes the selected candidates and, per candidate,
  decides what to investigate. It runs through an adapter that grants
  **read-only tool access** (web fetch / WebSearch / bounded shell for
  `git`), gathers evidence, and emits a structured **dossier** with explicit
  source attribution per claim.
- **write agent** consumes the dossier *only*. Its prompt forbids any claim
  not backed by a dossier entry. Because facts are pre-verified, the writer
  can focus on tone, structure, and the action triples (`if`/`do`/`verify`)
  already defined in the prompt.

### Why this beats "just fetch more in draft"

Fetching more deterministically still can't decide *what* is worth fetching
for a given item. The judgment — "this regression references commit X,
confirm whether it landed in stable" — is exactly what an agent does well
and a regex cannot. Splitting also keeps each AI call's context focused:
research reasons over raw material; writing reasons over verified facts.

## 3. Dossier schema (draft)

The contract between the two agents. One entry per selected candidate.
`research-latest.json`:

```json
{
  "topic": "linux",
  "date": "YYYY-MM-DD",
  "generatedAt": "ISO-8601",
  "adapter": "claude",
  "entries": [
    {
      "candidateId": "lore-lkml:...",
      "title": "...",
      "whatChanged": "one or two sentences, factual",
      "whyItMatters": "system-wide impact in plain Korean",
      "affectedAudience": "stable 커널 배포 담당자",
      "impactType": "regression",
      "confidence": "high | medium | low",
      "evidence": [
        { "claim": "...", "url": "https://...", "kind": "commit|thread|changelog|cve|article", "quote": "<=200 chars verbatim" }
      ],
      "openQuestions": ["unresolved item the writer must not assert"]
    }
  ],
  "droppedCandidates": [ { "candidateId": "...", "reason": "..." } ]
}
```

Hard rules carried into both prompts:

- Every `whatChanged` / `whyItMatters` claim must trace to an `evidence`
  entry with a real URL. No URL → it goes in `openQuestions`, not the body.
- `quote` is verbatim and short — it is the writer's grounding anchor.
- The writer may rephrase but may **not** introduce facts absent from
  `evidence`.

## 4. Adapter changes

`ai-rewrite-adapter.mjs` today runs closed prompts. The research agent needs
tool access; the write agent stays closed (and safer for it).

- Add a research-capable invocation. For Claude:
  `claude -p --allowedTools "WebFetch WebSearch Bash(git log:*)" ...` with an
  explicit, **read-only** tool allowlist and a network/time budget.
- Keep the write call exactly as the current closed transform.
- Research adapters (all tool-capable; `template` → deterministic fallback):
  - `claude` — read-only `--allowedTools WebFetch,WebSearch,Bash(git log:*)`
  - `codex` — `codex exec` sandbox tools
  - `cursor` — `--force` tool mode (vs `--mode=ask` for the closed rewrite)
  - all three share the `CLAUDE_RESEARCH_TIMEOUT_MS` wall-clock budget.
  - **Model split (B)**: research can use a heavier model than write via
    `CLAUDE_RESEARCH_MODEL` / `CODEX_RESEARCH_MODEL` / `CURSOR_RESEARCH_MODEL`
    (falls back to the write model `CLAUDE_MODEL`/… when unset). e.g.
    `CLAUDE_RESEARCH_MODEL=opus CLAUDE_MODEL=sonnet` → deep research, light write.

Determinism / audit:

- Persist `research-prompt-<date>.md`, `research-stdout-<date>.txt`, and
  `research-<date>.json` next to the existing rewrite artifacts under
  `data/generated/linux/`, mirroring the current snapshot+latest pattern.
- External fetches are non-deterministic; the dossier *is* the reproducible
  snapshot. A re-run of `write` against a frozen dossier must be stable.
- `RESEARCH_RAW_PATH=<stdout file>` re-parses a previous adapter stdout
  without re-calling the model (recovery/debugging).
- `normalizeDossier` trims any `evidence.quote` over 200 chars before
  validation, so a chatty model doesn't fail an otherwise-good dossier.
- **Time budget (decision #4)**: `runClaudeResearch` runs under a wall-clock
  timeout — default 10 min, `CLAUDE_RESEARCH_TIMEOUT_MS` overrides (0 =
  unbounded). On timeout the child is SIGTERM'd and the run fails loudly
  rather than hanging.
- **Cross-check (C)**: after a tool-research dossier is built, `verifyDossier`
  re-fetches each `evidence.url` and confirms the `quote` actually appears
  (normalized substring). If an entry's quoted evidence is all unverifiable,
  its `confidence` is downgraded and an openQuestion is appended — best-effort
  (failure downgrades, never blocks). Toggle `RESEARCH_VERIFY=0`,
  per-URL timeout `RESEARCH_VERIFY_TIMEOUT_MS` (default 15s). Skipped for the
  deterministic fallback (its evidence is just the candidate URL).
- **seenBefore (D)**: each entry is marked `seenBefore` when its candidateId
  appeared in yesterday's `research-<date-1>.json`, so the writer emphasizes
  change over repetition.

## 5. Tradeoffs

- **Cost/latency**: per-item fetch + two AI passes instead of one. Bounded by
  the existing 4-highlight / ~8-candidate cap, so this stays small.
- **Tool risk**: granting fetch/shell to an agent. Mitigated by a read-only
  allowlist, no write tools, and a network budget. Never grant publish.
- **Provider lock**: research needs a tool-capable CLI; `template`/`codex`
  paths keep working via the deterministic fallback (see Step 2).
- **Failure mode**: if research yields nothing for an item, the writer must
  degrade gracefully to the deterministic draft body, never fabricate.

## 6. Implementation steps (PoC: linux topic only)

### Step 1 — Dossier schema + validator ✅
- [x] `scripts/lib/dossier-schema.mjs` with `validateDossier`,
      `validateDossierEntry`, `validateEvidence` (every claim has an http(s)
      evidence URL; `impactType` reuses `highlight-schema`).
- [x] Unit test `scripts/dossier-schema.test.mjs` (14 cases: valid,
      missing-URL, empty-evidence, quote length, confidence, ctx prefix…).
- Exit met: `npm test` passes; validator rejects a claim with no evidence URL.

### Step 2 — Research stage (claude adapter, fallback-safe) ✅
- [x] `scripts/research-linux.mjs`: input = `candidates-latest.json`, output
      = `research-latest.json`. `AI_ADAPTER=claude` runs the tool-enabled
      prompt via `runResearchAdapterPrompt`; otherwise a deterministic
      dossier is built from the candidate records (so `template`/`codex` run
      end-to-end).
- [x] `prompts/linux-research-ko.md`: investigation instructions + dossier
      contract + read-only tool guidance.
- [x] adapter: `runResearchAdapterPrompt` (claude `--allowedTools
      WebFetch,WebSearch,Bash(git log:*)`) + `extractJsonObject`.
- Exit met: `AI_ADAPTER=template npm run research:linux` produced an 8-entry
      schema-valid dossier offline.

### Step 3 — Write stage consumes dossier ✅
- [x] `prompts/linux-newsletter-from-dossier-ko.md`: dossier-input prompt
      with the "no claim/URL without dossier evidence" rule; keeps
      title/headline/`if`/`do`/`verify` schema. (Kept `linux-newsletter-ko.md`
      as the draft fallback prompt rather than mutating it.)
- [x] `scripts/ai-rewrite-linux.mjs`: reads `research-latest.json` first,
      falls back to `draft-latest.json` when absent; grounding source is the
      dossier so `findUngroundedUrls` enforces dossier-only URLs.
- [x] `scripts/lib/dossier-to-post.mjs` + `dossier-to-post.test.mjs` (8
      cases): deterministic write fallback for non-claude adapters.
- Exit met: `validatePost` + `auditPostQuality` pass on both paths.

### Step 4 — Wire into daily pipeline + before/after ✅
- [x] `scripts/run-daily-linux.mjs`: inserted `research` between `draft` and
      `rewrite` (`researchScript` = claude tools or deterministic fallback).
- [x] Captured PoC before/after (see Status block).
- Exit met: `node scripts/run-daily-linux.mjs` ran `collect → draft →
      research → rewrite → build`, all ok; after-post URLs 10/10 grounded in
      dossier evidence.

## 7. Decisions (2026-06-06)

1. **Research tools** — `WebFetch` + `WebSearch` + `Bash(git log:*)`, all
   read-only. Maximize investigative depth; no write tools, ever.
2. **Secondary sources** — do NOT add LWN/Phoronix as collectors for the
   PoC. Prove the quality lift with lore+kernel.org + agent reasoning first.
   (`WebSearch` is still allowed, so the agent may reach a secondary page
   ad hoc when an item demands it — just not as a standing collector.)
3. **`enrichWithBodies`** — keep it in `draft` as the offline/`template`
   fallback (Step 2 emits a deterministic dossier from its output). Decided,
   not deferred.
4. **Network/time budget** — resolved: `runClaudeResearch` runs under a
   wall-clock timeout (default 10 min, `CLAUDE_RESEARCH_TIMEOUT_MS`, 0 =
   unbounded); SIGTERM + fail-loud on timeout. See §4.

## Multi-topic generalization (2026-06-06)

After the linux PoC, research was extracted into a topic-agnostic runner and
applied to a second topic to prove extensibility:

- `scripts/lib/research-runner.mjs` — topic-agnostic `runResearch(cfg)`.
  The claude/codex/cursor tool paths use only slim candidate fields +
  per-topic prompt (topic-independent). The deterministic fallback uses a
  generic entry builder (no topic helpers); a topic may inject a richer
  `entryBuilder` for better fallback quality (linux does, via
  `affectedAudienceFor`/`impactTypeFor`/`broadSubsystemsOf`).
- `dossierToPost` parameterized with `{topic, titleSuffix, tags}`.
- Applied to **opensource**: `research-opensource.mjs` (generic builder) +
  `opensource-research-ko.md` + `opensource-newsletter-from-dossier-ko.md` +
  `ai-rewrite-opensource.mjs` (dossier-first) + research step in
  `run-daily-opensource.mjs`. Verified: 14-entry dossier → write,
  grounding 12/12, title/tags topic-correct.

Remaining topics (android, lens, ai-coding-agents) follow the same recipe:
add two prompts + a thin `research-<topic>.mjs` + dossier-first write +
pipeline wiring.

## Out of scope

- Remaining-topic rollout (android, lens, ai-coding-agents) — same recipe,
  deferred.
- Replacing the regex Atom parser.
- API-billed providers (AGENTS.md prefers subscription CLIs).
