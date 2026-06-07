import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runWrite } from './lib/write-runner.mjs';

const root = process.cwd();
const topic = 'android';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-android-daily-briefing`;
const generatedDir = path.join(root, 'data', 'generated', topic);
const adapter = resolveAiAdapter();

function templateRewrite(draft) {
  const sectionByHeading = new Map(draft.sections.map((section) => [section.heading, section.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};
  return {
    ...draft,
    title: `${draft.date} Android 커널 개발 브리핑`,
    summary: `Android Common Kernel 변경 정리: 회귀·보안 ${buckets.regressions ?? 0}건, ACK 전용 패치 ${buckets.ackPatches ?? 0}건. 단일 vendor 디바이스 패치는 본문에서 제외했습니다.`,
    highlights: draft.highlights,
    sections: [
      { heading: '회귀·보안 신호', body: sectionByHeading.get('회귀·보안 신호') || '회귀·보안 신호로 분류된 항목이 없습니다.' },
      { heading: 'ACK 전용 변경', body: sectionByHeading.get('ACK 전용 변경') || '이번 수집에서 ACK 전용 시스템 영향 패치가 분류되지 않았습니다.' },
      { heading: '추적 브랜치', body: sectionByHeading.get('추적 브랜치') || '추적 브랜치 정보를 확인하지 못했습니다.' },
      { heading: '기타', body: sectionByHeading.get('기타') || '단일 vendor 디바이스 패치는 본문에서 제외했습니다.' },
    ],
    confidence: { level: '자동 생성', note: 'AI가 원문 후보와 메타데이터를 요약했습니다. 중요한 판단 전에는 링크된 원문을 확인하세요.' },
    draftMetadata: { ...draft.draftMetadata },
  };
}

runWrite({
  topic,
  postId,
  runDate,
  generatedDir,
  dossierPath: process.env.DOSSIER_PATH || path.join(generatedDir, 'research-latest.json'),
  draftPath: process.env.DRAFT_PATH || path.join(generatedDir, 'draft-latest.json'),
  fallbackDraftPath: path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`),
  draftPromptPath: path.join(root, 'prompts', 'android-newsletter-ko.md'),
  dossierPromptPath: path.join(root, 'prompts', 'android-newsletter-from-dossier-ko.md'),
  dossierMeta: { titleSuffix: 'Android 커널 개발 브리핑', tags: ['안드로이드', '커널'] },
  templateRewrite,
  adapter,
  logLabel: 'android',
})
  .then((r) => console.log(`Rewrote Android briefing with ${adapter} adapter; mode=${r.mode}; wrote data/generated/${topic}/rewritten-${postId}.json`))
  .catch((error) => { console.error(error); process.exit(1); });
