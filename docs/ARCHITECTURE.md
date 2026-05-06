# Dev Blog Architecture

## Overview

Dev Blog is a topic-extensible newsletter/blog pipeline.

The pipeline is intentionally split into independent stages:

1. collect source material
2. normalize source records
3. summarize with AI
4. publish to a static web/blog format
5. schedule and monitor recurring runs

The first implementation should be a simple static site generator. This keeps the baseline reproducible and avoids committing too early to a web framework or database.

## Core Concepts

### Topic

A topic defines a development area such as Linux, Android, or AI.

A topic owns:

- display metadata
- source configuration
- summarization preferences
- post archive
- tags/categories

### Source Record

A source record is a normalized item collected from an external source.

Examples:

- kernel release announcement
- patch series
- mailing list discussion
- roadmap note
- technical article
- git tag or merge window event

### Newsletter Post

A newsletter post is the user-facing article generated from source records and AI-assisted analysis.

It should include:

- title
- date
- topic
- summary
- sections
- source links
- technical implications
- tags

## Initial Build Strategy

Use a dependency-light Node.js static generator first:

- input: topic metadata and markdown/json post files
- output: static HTML under `public/`
- validation: build command exits non-zero on malformed content

This avoids per-request hosting/runtime costs and keeps publishing simple.

## AI Adapter Boundary

AI summarization should be behind an adapter so the project can support:

- `claude -p`
- OpenClaw workflows
- future approved subscription-based CLI agents
- optional API-backed providers only if explicitly approved

The rest of the pipeline should not depend on one provider's API shape.

## Scheduling Strategy

Start with documented local scheduling, then add automation:

- manual build command for development
- cron/OpenClaw cron for daily runs
- visible logs and failure handling

## Publishing Strategy

Start with generated static files in `public/`.

Later options:

- static hosting
- internal team web server
- GitHub Pages or similar
- RSS/Atom feed
- notification after successful publication
