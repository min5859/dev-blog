# Dev Blog

AI-assisted development newsletter/blog system.

**Target audience.** Kernel/driver/platform engineers, ACK vendor-tree maintainers, system & toolchain owners. Posts surface lore mail IDs, commit hashes, and subsystem slugs as-is. Newcomers should skim only the per-post one-line headline and the "오늘의 핵심" block.

The first topic is Linux kernel development. The architecture is intended to expand later to Android, AI, security, toolchains, distributions, and other engineering topics.

## Current Status

The static Korean blog MVP is working. Phase 2 source collection is active, and Phase 3 has a first AI-rewrite adapter boundary for Korean newsletter drafts.

Read the durable plan first:

- `docs/PLAN.md`
- `docs/ARCHITECTURE.md`

## Goals

- Generate a daily Linux development newsletter.
- Track kernel patches, roadmap signals, and major version history.
- Publish output as a shareable web/blog site.
- Prefer subscription-based AI execution through interchangeable CLI providers or OpenClaw workflows.
- Keep the system topic-extensible from the start.

## Source Collection

Collect Linux release metadata from kernel.org plus recent LKML Atom feed entries from lore.kernel.org, then normalize them into source records:

```bash
npm run collect:linux
```

Outputs are written under:

- `data/raw/linux/`
- `data/normalized/linux/`

Generate a newsletter draft from the latest normalized source records:

```bash
npm run draft:linux
```

Draft artifacts are written under `data/generated/linux/`. They are not published automatically.

Rewrite the metadata draft into a more readable Korean newsletter. The default
adapter is selected in `config/ai-provider.json`; supported values are
`claude`, `codex`, `cursor`, and the deterministic `template` adapter:

```bash
npm run rewrite:linux
```

Use `AI_ADAPTER` only for a one-off override without changing the configured
default:

```bash
AI_ADAPTER=claude npm run rewrite:linux
AI_ADAPTER=codex npm run rewrite:linux
AI_ADAPTER=cursor npm run rewrite:linux
AI_ADAPTER=template npm run rewrite:linux
```

The prompt template lives at `prompts/linux-newsletter-ko.md`.

Promote the latest generated rewrite into versioned site content only after review:

```bash
npm run publish:linux
```

Run the full daily pipeline without publishing to `content/`:

```bash
npm run daily:linux
```

Run and publish in one command only when the generated output is trusted:

```bash
npm run daily:linux:publish
```

Scheduling details and cron examples are documented in `docs/SCHEDULING.md`.

Runtime data outputs are ignored by git because they are reproducible and change over time. Generated posts under `content/` are versioned.

## Local Preview

The site can be previewed locally. Once pushed to a GitHub repo with Pages enabled, `.github/workflows/pages.yml` deploys automatically — see `docs/DEPLOYMENT.md`.

```bash
npm run dev
```

Then open:

```text
http://localhost:4321
```

Use a different port if needed:

```bash
PORT=8080 npm run dev
```
