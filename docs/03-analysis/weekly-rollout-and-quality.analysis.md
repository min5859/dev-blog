# Analysis — weekly-rollout-and-quality (PDCA #4)

- Date: 2026-06-07
- 대상: SC-1(weekly-rollup 멀티토픽), SC-2(전 토픽 claude 실운영 정량화), SC-0(회귀)

## SC-1 weekly-rollup 멀티토픽 — Met
`scripts/weekly-rollup.mjs <topic>` + TOPIC_META 맵으로 전 토픽 주간 롤업 생성 확인:
linux 8 / opensource 8 / android 8 / ai-coding-agents 8 / opensource-curation 5(큐레이션 섹션 유지) / lens 8 key entries. 모두 schema-valid.

## SC-2 전 토픽 claude 실운영 정량화 — Met

write 엔진과 무관하게 **research 단계만 template→claude 로 바꿔** 측정(동일 candidates, NEWSLETTER_DATE=2026-06-07).
before = template(candidate url 기반 deterministic), after = claude(도구 조사).

### 측정표 (before → after)

| topic | entries | evidence | **원문 quote** | article kind | candidate밖 URL |
|-------|:------:|:-------:|:------:|:------:|:------:|
| linux | 10→6 | 10→11 | 8→11 | 0→**4** | 0→**5** |
| opensource | 12→10 | 12→12 | 0→**12** | 0→**1** | 0→**2** |
| android | 11→9 | 11→9 | 0→**9** | 0→0 | 0→0 |
| ai-coding-agents | 12→8 | 12→12 | 0→**12** | 0→**3** | 0→**2** |
| opensource-curation | 5→5 | 5→8 | 0→**8** | 0→**4** | 0→**7** |
| linux-kernel-security(lens) | 10→7 | 10→13 | 0→**13** | 0→**2** | 0→**5** (+CVE 1) |

### 해석
1. **원문 인용 확보(quote)**: 6/6 토픽에서 대폭 증가(대부분 0→8~13). template 은 commitMessage 없는 토픽(GitHub repo 등)에서 인용을 못 만들지만, claude 는 URL 을 fetch 해 원문 발췌를 확보 → 본문 blockquote 노출 가능.
2. **2차 소스 능동 확보(article + candidate밖 URL)**: 5/6 토픽에서 0→다수. claude 가 candidates 에 없던 외부 소스(LWN·Phoronix·문서·HN 등)를 가져옴. opensource-curation 이 가장 큼(외부 7).
3. **질적 선별(entries 감소)**: 대부분 entries 가 줄어듦(claude 가 국부·저가치 항목을 스스로 제외).
4. **예외 — android**: claude 가 외부 2차 소스 0. android 소스(ACK 패치/벤더 트리)는 외부 분석 글이 희박해 candidate 원문 확인에 머묾. quote 는 0→9 로 확보됨(원문 인용은 됨). → 후속: android 전용 2차 소스(AOSP 보안 회보 등) 추가 시 개선 여지.

### 결론
dossier-first 의 claude 실운영이 **전 토픽에서 원문 인용을, 5/6 토픽에서 외부 2차 소스를** 실제로 확보함을 정량 확인. PDCA #3 의 배선이 template 검증을 넘어 claude 실운영에서도 품질 리프트를 낸다는 것이 입증됨.

## SC-0 회귀 — Met
`npm test` 115 pass.

## Note
측정 중 각 토픽 research-latest.json 이 claude 결과로 덮였음(content/ 발행은 안 함).
