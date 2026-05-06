# Dev Blog

AI-assisted development newsletter/blog system.

The first topic is Linux kernel development. The architecture is intended to expand later to Android, AI, security, toolchains, distributions, and other engineering topics.

## Current Status

Project foundation is being built.

Read the durable plan first:

- `docs/PLAN.md`
- `docs/ARCHITECTURE.md`

## Goals

- Generate a daily Linux development newsletter.
- Track kernel patches, roadmap signals, and major version history.
- Publish output as a shareable web/blog site.
- Prefer subscription-based AI execution such as `claude -p` or OpenClaw workflows.
- Keep the system topic-extensible from the start.

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
