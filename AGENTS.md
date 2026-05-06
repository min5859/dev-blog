# AGENTS.md - Dev Blog

## Role

You are a coding specialist for this project.

- Focus on concrete implementation, debugging, tests, refactors, and technical review.
- Prefer evidence, code inspection, and verification over guesswork.
- Keep changes minimal, reversible, and aligned with the product goal.
- Use Korean 존댓말 when communicating with the primary user.

## Project Background

The primary user is a Linux kernel developer who wants to continuously monitor Linux development news and share useful updates with teammates.

## Product Goal

Build Dev Blog: a periodically running AI-assisted newsletter/blog system that tracks Linux development topics, summarizes them clearly, and publishes them on the web in a shareable blog-like format.

The first supported topic is Linux development, but the architecture should be topic-extensible from the start so it can later cover areas such as Android and AI.

## Core Requirements

- Produce a daily Linux development newsletter.
- Monitor what has landed in Linux kernel patches.
- Track and explain upcoming Linux kernel roadmaps.
- Preserve and present the development history of major Linux versions.
- Publish the output on the web so other team members can read and share it like a blog.
- Run automatically on a daily schedule.
- Use AI to summarize news into clear, accessible, and insight-rich content.
- Prefer subscription-based AI execution paths that avoid per-API-call costs, such as `claude -p` or OpenClaw-based workflows.

## Design Preferences

- Treat Linux as the first topic, but keep the architecture extensible for future topics.
- Separate collection, summarization, publishing, storage, and scheduling concerns where practical.
- Prefer reproducible pipelines and durable stored outputs over one-off chat summaries.
- Keep content understandable for engineers while highlighting technical implications and actionable insights.
- Store generated newsletters and source metadata durably so past outputs can be audited or regenerated.
- Design for team-facing sharing from the beginning: archives, stable URLs, tags, and search should be considered.

## Initial Domain Scope

### Linux Development Newsletter

The daily newsletter should eventually include:

- Important merged or proposed kernel patches.
- Kernel subsystem highlights.
- Release candidate and stable release updates.
- Roadmap signals from mailing lists, maintainer notes, LWN/kernel.org/Phoronix-style sources, and official release activity.
- Historical context for major Linux versions when relevant.
- Practical implications for kernel developers and engineering teams.

### Future Expansion Topics

Potential future topic channels:

- Android
- AI
- Security
- Toolchains
- Distributions
- Performance engineering

## Architecture Direction

Keep the system modular. A likely high-level structure:

- `collectors`: fetch raw source material from feeds, git logs, mailing lists, release notes, or web sources.
- `summarizers`: transform collected material into concise AI-assisted summaries.
- `publishers`: render newsletters to web/blog pages and indexes.
- `scheduler`: run the daily pipeline automatically.
- `storage`: persist source snapshots, generated articles, metadata, and publication history.
- `topics`: define per-topic configuration so Linux is not hard-coded everywhere.

## AI Execution Preference

Prefer AI execution paths that use existing subscriptions or local/OpenClaw workflows instead of per-request API billing.

Examples:

- `claude -p`
- OpenClaw agent workflows
- Other subscription-based CLI agents if approved

Avoid designing the core system around mandatory metered API calls unless the user explicitly approves that tradeoff.

## Engineering Rules

- Inspect existing code before proposing or making changes.
- Do not modify unrelated files.
- Do not introduce credentials or secrets into the repository.
- Ask before destructive actions, publishing, changing auth, or making system-wide configuration changes.
- Add tests when there is a natural test surface.
- Verify changes with the smallest meaningful command before claiming completion.
