import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runWrite } from './lib/write-runner.mjs';

const root = process.cwd();
const topic = 'opensource';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-opensource-trending`;
const generatedDir = path.join(root, 'data', 'generated', topic);
const adapter = resolveAiAdapter();

// opensource 고유 draft fallback
function templateRewrite(draft) {
  const sectionByHeading = new Map(draft.sections.map((s) => [s.heading, s.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};
  return {
    ...draft,
    title: `${draft.date} 오픈소스 트렌드`,
    summary: `오늘 GitHub 트렌딩: HN frontpage ${buckets.hnHits ?? 0}건, 60일 내 신규 ${buckets.newRepos ?? 0}건, 별 5k+ 활발 ${buckets.activeGiants ?? 0}건.`,
    highlights: draft.highlights,
    sections: [
      { heading: '지금 화제 (HN frontpage)', body: sectionByHeading.get('지금 화제 (HN frontpage)') || 'Hacker News frontpage에 GitHub URL 신호가 없습니다.' },
      { heading: '최근 떠오른 신규 프로젝트', body: sectionByHeading.get('최근 떠오른 신규 프로젝트') || '60일 내 만들어진 인기 신규 프로젝트가 잡히지 않았습니다.' },
      { heading: '활발히 갱신 중인 인기 프로젝트', body: sectionByHeading.get('활발히 갱신 중인 인기 프로젝트') || '별 5k 이상 활발 프로젝트가 잡히지 않았습니다.' },
      { heading: '기타', body: sectionByHeading.get('기타') || '검색 API의 별 수 정렬은 long-tail 거대 프로젝트로 치우치므로 신규/HN 섹션을 우선 참고하세요.' },
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
  draftPromptPath: path.join(root, 'prompts', 'opensource-newsletter-ko.md'),
  dossierPromptPath: path.join(root, 'prompts', 'opensource-newsletter-from-dossier-ko.md'),
  dossierMeta: { titleSuffix: '오픈소스 트렌드', tags: ['오픈소스', 'GitHub'] },
  templateRewrite,
  adapter,
  logLabel: 'opensource',
})
  .then((r) => console.log(`Rewrote opensource trending with ${adapter} adapter; mode=${r.mode}; wrote data/generated/${topic}/rewritten-${postId}.json`))
  .catch((error) => { console.error(error); process.exit(1); });
