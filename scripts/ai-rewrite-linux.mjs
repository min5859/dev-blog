import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runWrite } from './lib/write-runner.mjs';

const root = process.cwd();
const topic = 'linux';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-linux-daily-briefing`;
const generatedDir = path.join(root, 'data', 'generated', topic);
const adapter = resolveAiAdapter();

// linux 고유 draft fallback (dossier 없을 때만 사용)
function templateRewrite(draft) {
  const sectionByHeading = new Map(draft.sections.map((section) => [section.heading, section.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};
  return {
    ...draft,
    title: `${draft.date} 커널 개발 브리핑`,
    summary: `오늘의 핵심: 릴리스 ${buckets.releases ?? 0}건, 회귀·보안 ${buckets.regressions ?? 0}건, 시스템 영향 패치 ${buckets.patches ?? 0}건. 국부 드라이버/플랫폼 패치는 본문에서 제외했습니다.`,
    highlights: draft.highlights,
    sections: [
      { heading: '릴리스/로드맵', body: sectionByHeading.get('릴리스/로드맵') || '이번 수집에서 신규 릴리스가 없습니다.' },
      { heading: '회귀·보안 신호', body: sectionByHeading.get('회귀·보안 신호') || '회귀·보안 신호로 분류된 항목이 없습니다.' },
      { heading: '핵심 변경', body: sectionByHeading.get('핵심 변경') || '이번 수집에서 시스템 전반에 영향을 줄 변경이 분류되지 않았습니다.' },
      { heading: '기타', body: sectionByHeading.get('기타') || '국부 드라이버/플랫폼 패치는 본문에서 제외했습니다.' },
    ],
    confidence: {
      level: '자동 생성',
      note: 'AI가 원문 후보와 메타데이터를 요약했습니다. 중요한 판단 전에는 링크된 원문을 확인하세요.',
    },
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
  draftPromptPath: path.join(root, 'prompts', 'linux-newsletter-ko.md'),
  dossierPromptPath: path.join(root, 'prompts', 'linux-newsletter-from-dossier-ko.md'),
  dossierMeta: { titleSuffix: '커널 개발 브리핑', tags: ['리눅스', '커널'] },
  templateRewrite,
  adapter,
  logLabel: 'linux',
})
  .then((r) => console.log(`Rewrote Linux newsletter with ${adapter} adapter; mode=${r.mode}; wrote data/generated/${topic}/rewritten-${postId}.json`))
  .catch((error) => { console.error(error); process.exit(1); });
