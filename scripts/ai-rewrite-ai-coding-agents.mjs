import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runWrite } from './lib/write-runner.mjs';

const root = process.cwd();
const topic = 'ai-coding-agents';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-ai-coding-agents-daily`;
const generatedDir = path.join(root, 'data', 'generated', topic);
const adapter = resolveAiAdapter();

function templateRewrite(draft) {
  const sectionByHeading = new Map(draft.sections.map((s) => [s.heading, s.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};
  return {
    ...draft,
    title: `${draft.date} AI 코딩 에이전트 동향`,
    summary: `오늘 릴리스·체인지로그 ${buckets.releases ?? 0}건, HN 화제 ${buckets.hnDiscussions ?? 0}건, 블로그 포스트 ${buckets.blogPosts ?? 0}건.`,
    highlights: draft.highlights,
    sections: [
      { heading: '신규 릴리스·기능', body: sectionByHeading.get('신규 릴리스·기능') || '오늘 새 릴리스·체인지로그 신호가 없습니다.' },
      { heading: '실전 활용·팁', body: sectionByHeading.get('실전 활용·팁') || 'HN에서 AI 코딩 에이전트 관련 화제 토론이 없습니다.' },
      { heading: '업계 동향', body: sectionByHeading.get('업계 동향') || '오늘 주목할 만한 업계 블로그 포스트가 없습니다.' },
      { heading: '기타', body: sectionByHeading.get('기타') || '그 외 소소한 업데이트는 없습니다.' },
    ],
    confidence: { level: '자동 생성', note: 'AI가 수집된 릴리스 노트·블로그·HN 신호를 요약했습니다. 중요한 판단 전에는 링크된 원문을 확인하세요.' },
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
  draftPromptPath: path.join(root, 'prompts', 'ai-coding-agents-newsletter-ko.md'),
  dossierPromptPath: path.join(root, 'prompts', 'ai-coding-agents-newsletter-from-dossier-ko.md'),
  dossierMeta: { titleSuffix: 'AI 코딩 에이전트 동향', tags: ['AI', '코딩에이전트'] },
  templateRewrite,
  adapter,
  logLabel: 'ai-coding-agents',
})
  .then((r) => console.log(`Rewrote AI coding agents digest with ${adapter} adapter; mode=${r.mode}; wrote data/generated/${topic}/rewritten-${postId}.json`))
  .catch((error) => { console.error(error); process.exit(1); });
