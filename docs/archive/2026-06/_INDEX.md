# Archive Index — 2026-06

| Feature | Cycle | Match Rate | Archived | Documents |
|---------|:-----:|:----------:|----------|-----------|
| research-write-split | #1 | 99.2% | 2026-06-06 | [analysis](research-write-split/research-write-split.analysis.md) · [report](research-write-split/research-write-split.report.md) |
| content-quality-enhancements | #2 | 98% | 2026-06-07 | [plan](content-quality-enhancements/content-quality-enhancements.plan.md) · [analysis](content-quality-enhancements/content-quality-enhancements.analysis.md) · [report](content-quality-enhancements/content-quality-enhancements.report.md) |
| topic-dossier-first-rollout | #3 | 94% | 2026-06-07 | [plan](topic-dossier-first-rollout/topic-dossier-first-rollout.plan.md) · [analysis](topic-dossier-first-rollout/topic-dossier-first-rollout.analysis.md) · [report](topic-dossier-first-rollout/topic-dossier-first-rollout.report.md) |

## content-quality-enhancements (#2)
원문 인용(A)·모델 분리(B)·교차검증(C)·변화 중심(D)·주간 롤업(E). dossier 자산을 콘텐츠 품질로 전환.

## topic-dossier-first-rollout (#3)
write-runner 공통화 + 전 토픽(android/ai-coding-agents/opensource-curation/lore-lens 7렌즈) dossier-first 확장.

## research-write-split

조사(research)와 작문(write) 분리 + dossier(claim마다 evidence URL 강제) PoC.
claude 도구 조사로 본문 정보밀도 2.1배·2차 소스(LWN) 0→2·CVE 0→4 확인.

- **Living spec (not archived)**: [docs/RESEARCH-WRITE-SPLIT.md](../../RESEARCH-WRITE-SPLIT.md) — 멀티토픽 확장 기준 문서로 계속 사용.
- Deliverables: `scripts/lib/dossier-schema.mjs`, `scripts/research-linux.mjs`, `scripts/lib/dossier-to-post.mjs`, `prompts/linux-research-ko.md`, `prompts/linux-newsletter-from-dossier-ko.md`.
