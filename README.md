# Dev Blog

AI-assisted development newsletter/blog system.

The first topic is Linux kernel development. The architecture is intended to expand later to Android, AI, security, toolchains, distributions, and other engineering topics.

## Current Status

The static Korean blog MVP is working. Phase 2 source collection has started with kernel.org release metadata and LKML Atom feed collection from lore.kernel.org.

Read the durable plan first:

- `docs/PLAN.md`
- `docs/ARCHITECTURE.md`

## Goals

- Generate a daily Linux development newsletter.
- Track kernel patches, roadmap signals, and major version history.
- Publish output as a shareable web/blog site.
- Prefer subscription-based AI execution such as `claude -p` or OpenClaw workflows.
- Keep the system topic-extensible from the start.

## Source Collection

Collect Linux release metadata from kernel.org plus recent LKML Atom feed entries from lore.kernel.org, then normalize them into source records:

```bash
npm run collect:linux
```

Outputs are written under:

- `data/raw/linux/`
- `data/normalized/linux/`

Generate a Korean newsletter draft from the latest normalized source records:

```bash
npm run draft:linux
```

Draft artifacts are written under `data/generated/linux/`, and the publishable draft post is written to `content/topics/linux/posts/`.

Runtime data outputs are ignored by git because they are reproducible and change over time. Generated posts under `content/` are versioned.

## Local Preview

This MVP is intended to be checked locally first. It does not deploy anywhere yet.

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
