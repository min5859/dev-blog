# Dev Blog Execution Plan

## Purpose

Dev Blog is an AI-assisted, periodically running newsletter/blog system for development topics.

The first topic is Linux development. The system should later expand to Android, AI, security, toolchains, distributions, and other engineering topics.

This document is the durable work plan. Future sessions should read this file first, then continue from the current phase and checklist.

## Product Direction

Build a daily web-published newsletter that helps Linux kernel developers track:

- important kernel patches and merge activity
- upcoming kernel roadmap signals
- major version history and technical evolution
- practical engineering implications
- source links and context for deeper review

The output should be readable like a blog and shareable with teammates.

## Key Principles

- Linux is the first topic, not the only topic.
- Keep collectors, summarizers, publishers, storage, and scheduling separate.
- Prefer durable generated files and metadata over one-off chat summaries.
- Prefer subscription-based AI execution paths such as `claude -p` or OpenClaw workflows instead of mandatory per-request API billing.
- Start simple and reproducible before adding infrastructure.
- Every phase should leave the repository in a working, committed state.

## Milestones

### Phase 0 — Project Foundation

Goal: create a durable project baseline that future sessions can continue.

Status: completed

Checklist:

- [x] Create project folder under `~/project/git/wk/dev-blog`
- [x] Initialize git repository
- [x] Add project context in `AGENTS.md`
- [x] Add durable execution plan in `docs/PLAN.md`
- [x] Add minimal static blog generator
- [x] Add sample Linux newsletter output
- [x] Add basic validation command
- [x] Add local preview command (`npm run dev`)

Exit criteria:

- A developer can run one local command and preview a readable static blog page on localhost.
- The project has a committed baseline.

### Phase 1 — Static Blog MVP

Goal: publish generated newsletters as static HTML files.

Planned work:

- Define topic metadata format.
- Define newsletter article metadata format.
- Generate:
  - homepage
  - per-topic index
  - individual newsletter post pages
- Keep generated output in `public/`.
- Add `npm run build` or equivalent command.

Exit criteria:

- `npm run build` generates a usable static site in `public/`.
- At least one sample Linux newsletter page exists.

### Phase 2 — Source Collection MVP

Goal: collect Linux development source material reproducibly.

Status: in progress

Initial candidate sources:

- kernel.org releases and stable updates
- Linux git tags / release candidates
- LKML or lore.kernel.org queries
- LWN/kernel coverage where accessible
- maintainer or subsystem feeds if available
- Phoronix-style public news sources as secondary context

Planned work:

- [x] Add source configuration per topic.
- [x] Add collector scripts that store raw snapshots under `data/raw/`.
- [x] Add normalized source records under `data/normalized/`.
- [x] Avoid brittle scraping where feeds or structured data are available.
- [x] Add lore.kernel.org patch/discussion collection.
- [ ] Add sample fixtures or documented artifact retention policy for CI/offline checks.
- [ ] Add topic-specific filtering/scoring so LKML volume is reduced to newsletter-worthy records.

Exit criteria:

- One command collects source metadata for Linux.
- Raw and normalized outputs are committed only if appropriate; otherwise sample fixtures are committed.

### Phase 3 — AI Summarization Pipeline

Goal: convert collected source records into newsletter drafts.

Planned work:

- Define prompt templates for daily Linux summaries.
- Support subscription-based AI execution first:
  - `claude -p`
  - OpenClaw workflow invocation
- Keep AI provider execution behind an adapter boundary.
- Store generated drafts with source references and prompt metadata.

Exit criteria:

- A draft newsletter can be generated from stored source records.
- The draft includes links, technical implications, and confidence/source notes.

### Phase 4 — Scheduling

Goal: run the pipeline daily.

Planned work:

- Add local cron/system scheduler documentation.
- Add OpenClaw cron option if appropriate.
- Ensure logs and generated artifacts are easy to inspect.
- Make failures visible without silently skipping a day.

Exit criteria:

- Daily generation can be scheduled with documented commands.
- Failure handling and rerun behavior are documented.

### Phase 5 — Team Sharing Improvements

Goal: make the site more useful as a team-facing blog.

Planned work:

- Add tags and archives.
- Add RSS/Atom feed.
- Add search or static index data.
- Add stable URLs.
- Add optional notification after publishing.

Exit criteria:

- Teammates can browse archives and subscribe/follow updates.

### Phase 6 — Multi-topic Expansion

Goal: add more development topics without rewriting the system.

Planned work:

- Add Android topic configuration.
- Add AI topic configuration.
- Validate that topic-specific collectors and summarizers can differ.
- Keep common publishing pipeline shared.

Exit criteria:

- At least two topics can generate independent newsletter/blog pages.

## Proposed Repository Structure

```text
AGENTS.md
README.md
package.json
docs/
  PLAN.md
  ARCHITECTURE.md
content/
  topics/
    linux/
      topic.json
      posts/
data/
  raw/
  normalized/
  generated/
scripts/
  build-site.mjs
  collect-linux.mjs
  summarize.mjs
public/
  index.html
  topics/
  posts/
```

## Immediate Next Steps

1. Create the minimal static blog generator.
2. Add Linux topic metadata.
3. Add one sample newsletter post.
4. Add build validation.
5. Commit the baseline.

## Continuation Notes for Future AI Sessions

When resuming work:

1. Read `AGENTS.md`.
2. Read this `docs/PLAN.md`.
3. Run `git status --short`.
4. Check the current phase checklist.
5. Make one small, verifiable step.
6. Run the smallest meaningful validation command.
7. Commit the result with a clear message.

## Local MVP Usage

The current MVP is local-only. It does not deploy to GitHub Pages or any external host yet.

Run:

```bash
npm run dev
```

Open:

```text
http://localhost:4321
```

For another port:

```bash
PORT=8080 npm run dev
```
