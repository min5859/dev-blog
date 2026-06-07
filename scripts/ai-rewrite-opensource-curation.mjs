import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runWrite } from './lib/write-runner.mjs';

const root = process.cwd();
const topic = 'opensource-curation';
const PICK_HEADING = '이번 주 선정 (큐레이션)';
// 큐레이션은 impactType 무관하게 선정 레포를 한 섹션에 모은다(linux 4섹션 대신 큐레이션 정체성 유지).
const CURATION_IMPACTS = ['security', 'regression', 'build', 'runtime', 'api-abi', 'backport', 'performance', 'release', 'project'];
const CURATION_SECTION_BY_IMPACT = Object.fromEntries(CURATION_IMPACTS.map((k) => [k, PICK_HEADING]));
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-opensource-curation`;
const generatedDir = path.join(root, 'data', 'generated', topic);
const adapter = resolveAiAdapter();

function templateRewrite(draft) {
  const sectionByHeading = new Map(draft.sections.map((s) => [s.heading, s.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};
  return {
    ...draft,
    title: `${draft.date} 오픈소스 큐레이션`,
    summary:
      (draft.summary && String(draft.summary).replace(/\s*\(초안\)\s*$/, '').trim())
      || `선정 레포 ${draft.draftMetadata?.candidateCount ?? 0}건 — 심층 분석 ${buckets.withAnalysis ?? 0}건.`,
    tags: ['opensource-curation', 'github', 'opensource'],
    sections: [
      { heading: PICK_HEADING, body: sectionByHeading.get(PICK_HEADING) || '선정 레포 요약이 없습니다.' },
      { heading: '언어·규모 스냅샷', body: sectionByHeading.get('언어·규모 스냅샷') || '스냅샷이 비었습니다.' },
      { heading: '심층 분석 하이라이트', body: sectionByHeading.get('심층 분석 하이라이트') || '분석 발췌가 없습니다.' },
      { heading: '기타', body: sectionByHeading.get('기타') || '데이터를 주기적으로 갱신하세요.' },
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
  draftPromptPath: path.join(root, 'prompts', 'opensource-curation-newsletter-ko.md'),
  dossierPromptPath: path.join(root, 'prompts', 'opensource-curation-newsletter-from-dossier-ko.md'),
  dossierMeta: {
    titleSuffix: '오픈소스 큐레이션',
    tags: ['opensource-curation', 'github', 'opensource'],
    sectionOrder: [PICK_HEADING, '기타'],
    sectionByImpact: CURATION_SECTION_BY_IMPACT,
    emptyOtherText: '큐레이션 선정 외 추가 항목은 없습니다.',
  },
  templateRewrite,
  adapter,
  logLabel: 'opensource-curation',
})
  .then((r) => console.log(`Rewrote opensource curation with ${adapter} adapter; mode=${r.mode}; wrote data/generated/${topic}/rewritten-${postId}.json`))
  .catch((error) => { console.error(error); process.exit(1); });
